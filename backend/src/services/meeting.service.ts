import { google, type calendar_v3 } from 'googleapis';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import {
  getSalesforceContext,
  createOpportunity,
  type CreateOpportunityResult,
} from './salesforce.service.js';

/**
 * Meeting assignment desk (Book meeting), modeled on the Emergence webapp's
 * SourcingAssignmentDesk. The webapp counts each Sourcing Lead's calendar via
 * their personal OAuth refresh token; this standalone app instead uses the
 * shared Google service account (AWS: emergence/google/service-account) with
 * domain-wide delegation, so any @emergence.com calendar is readable without
 * per-user setup.
 */

const WEEK_TZ = 'America/Los_Angeles';
const CACHE_TTL_MS = 3 * 60_000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let serviceAccount: ServiceAccount | null = null;
function getServiceAccount(): ServiceAccount {
  if (!serviceAccount) {
    serviceAccount = JSON.parse(
      Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'),
    ) as ServiceAccount;
  }
  return serviceAccount;
}

function calendarFor(subjectEmail: string): calendar_v3.Calendar {
  const sa = getServiceAccount();
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    subject: subjectEmail,
  });
  return google.calendar({ version: 'v3', auth: jwt });
}

/**
 * Calendar client that WRITES to the meeting owner's calendar. The shared
 * service account only has calendar.readonly delegated, so — exactly like the
 * Emergence webapp — booking authenticates as meeting@emergence.com via that
 * user's OAuth refresh token (calendar.events scope).
 */
function meetingOwnerCalendar(): calendar_v3.Calendar {
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: env.GOOGLE_MEETING_OWNER_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

/** Date parts of `date` in the desk's timezone. */
function tzParts(date: Date): { y: number; m: number; d: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: WEEK_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    weekday: weekdays.indexOf(parts.weekday),
  };
}

/** UTC instant of local midnight in the desk timezone for a y/m/d. */
function tzMidnightUtc(y: number, m: number, d: number): Date {
  // Guess then correct: start from UTC midnight and shift by the zone offset.
  let guess = new Date(Date.UTC(y, m - 1, d, 8)); // LA is UTC-7/-8; 08:00Z ≈ local 00/01
  for (let i = 0; i < 3; i += 1) {
    const p = tzParts(guess);
    const localAsUtc = Date.UTC(p.y, p.m - 1, p.d);
    const targetAsUtc = Date.UTC(y, m - 1, d);
    const diffDays = (targetAsUtc - localAsUtc) / 86_400_000;
    if (diffDays === 0) break;
    guess = new Date(guess.getTime() + diffDays * 86_400_000);
  }
  // Walk back to the local midnight boundary.
  const hourFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: WEEK_TZ,
    hour: 'numeric',
    hour12: false,
  });
  const hour = Number(hourFmt.format(guess));
  return new Date(guess.getTime() - hour * 3_600_000);
}

/**
 * Monday-start week bounds in the desk timezone, `offset` weeks from now
 * (matching the webapp's "Sep 7–13" style weeks).
 */
export function weekBounds(offset = 0, now = new Date()): { start: Date; end: Date; label: string } {
  const today = tzParts(now);
  const sinceMonday = (today.weekday + 6) % 7;
  const monday = new Date(
    Date.UTC(today.y, today.m - 1, today.d) - sinceMonday * 86_400_000 + offset * 7 * 86_400_000,
  );
  const y = monday.getUTCFullYear();
  const m = monday.getUTCMonth() + 1;
  const d = monday.getUTCDate();
  const start = tzMidnightUtc(y, m, d);
  // The next Monday's LOCAL midnight — not start + 168h. A Pacific week that
  // spans a DST change is 167h (spring-forward) or 169h (fall-back), so a fixed
  // seven-day add drifts the upper bound by an hour and mis-slices the week
  // (dropping the last local hour, or spilling into Monday).
  const nextMonday = new Date(Date.UTC(y, m - 1, d) + 7 * 86_400_000);
  const end = tzMidnightUtc(
    nextMonday.getUTCFullYear(),
    nextMonday.getUTCMonth() + 1,
    nextMonday.getUTCDate(),
  );
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const fmt = (dt: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(dt);
  const label = `${fmt(monday)}–${sunday.getUTCDate()}, ${sunday.getUTCFullYear()}`;
  return { start, end, label };
}

/**
 * Counts calendar meetings in [start, end): timed (not all-day), not
 * cancelled, not free/transparent — the same "busy meeting blocks" the
 * reference desk treats as capacity usage.
 */
async function countMeetings(email: string, start: Date, end: Date): Promise<number> {
  const calendar = calendarFor(email);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });
  return (res.data.items ?? []).filter((item) => {
    if (item.status === 'cancelled') return false;
    if (item.transparency === 'transparent') return false;
    if (!item.start?.dateTime) return false; // all-day blocks are not meetings
    return true;
  }).length;
}

export interface DeskAssignee {
  id: string;
  name: string;
  email: string;
  tag: string;
  weeklyMeetingLimit: number;
  /** Meetings on their calendar this week; null when the lookup failed. */
  meetingsThisWeek: number | null;
  calendarError: string | null;
}

const deskCache = new Map<string, { at: number; data: DeskAssignee[] }>();

export function invalidateDeskCache(workspaceId: string) {
  for (const key of deskCache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) deskCache.delete(key);
  }
}

export async function getAssignmentDesk(workspaceId: string, weekOffset = 0) {
  if (!env.CALENDAR_READY) {
    throw new AppError(
      'validation_error',
      'Calendar is not configured. Set GOOGLE_SERVICE_ACCOUNT_B64.',
      400,
    );
  }
  const { start, end, label } = weekBounds(weekOffset);
  const assignees = await prisma.meetingAssignee.findMany({
    where: { workspaceId },
    orderBy: { name: 'asc' },
  });

  const cacheKey = `${workspaceId}:${weekOffset}:${assignees.map((a) => a.email).join(',')}`;
  const cached = deskCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { weekLabel: label, weekStart: start.toISOString(), assignees: cached.data };
  }

  const rows: DeskAssignee[] = await Promise.all(
    assignees.map(async (assignee) => {
      try {
        const count = await countMeetings(assignee.email, start, end);
        return {
          id: assignee.id,
          name: assignee.name,
          email: assignee.email,
          tag: assignee.tag,
          weeklyMeetingLimit: assignee.weeklyMeetingLimit,
          meetingsThisWeek: count,
          calendarError: null,
        };
      } catch (error) {
        return {
          id: assignee.id,
          name: assignee.name,
          email: assignee.email,
          tag: assignee.tag,
          weeklyMeetingLimit: assignee.weeklyMeetingLimit,
          meetingsThisWeek: null,
          calendarError: (error as Error).message?.slice(0, 120) ?? 'Calendar unavailable',
        };
      }
    }),
  );

  deskCache.set(cacheKey, { at: Date.now(), data: rows });
  return { weekLabel: label, weekStart: start.toISOString(), assignees: rows };
}

export interface AssigneeCalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay: boolean;
  busy: boolean;
}

/** One member's events for the desk week — powers the calendar step. */
export async function getAssigneeWeekEvents(
  workspaceId: string,
  assigneeId: string,
  weekOffset = 0,
) {
  if (!env.CALENDAR_READY) {
    throw new AppError('validation_error', 'Calendar is not configured.', 400);
  }
  const assignee = await prisma.meetingAssignee.findFirst({
    where: { id: assigneeId, workspaceId },
  });
  if (!assignee) throw new AppError('not_found', 'Assignee not found.', 404);

  const { start, end, label } = weekBounds(weekOffset);
  const calendar = calendarFor(assignee.email);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });
  const events: AssigneeCalendarEvent[] = (res.data.items ?? [])
    .filter((item) => item.status !== 'cancelled' && (item.start?.dateTime || item.start?.date))
    .map((item) => ({
      id: item.id ?? '',
      summary: item.summary ?? '(No title)',
      start: item.start?.dateTime ?? item.start?.date ?? '',
      end: item.end?.dateTime ?? item.end?.date ?? '',
      isAllDay: !item.start?.dateTime,
      busy: item.transparency !== 'transparent',
    }));

  return {
    weekLabel: label,
    weekStart: start.toISOString(),
    assignee: { id: assignee.id, name: assignee.name, email: assignee.email },
    events,
  };
}

export async function updateAssigneeLimit(
  workspaceId: string,
  assigneeId: string,
  weeklyMeetingLimit: number,
) {
  if (!Number.isInteger(weeklyMeetingLimit) || weeklyMeetingLimit < 0) {
    throw new AppError('validation_error', 'Weekly limit must be a non-negative integer.', 400);
  }
  const updated = await prisma.meetingAssignee.updateMany({
    where: { id: assigneeId, workspaceId },
    data: { weeklyMeetingLimit },
  });
  if (!updated.count) throw new AppError('not_found', 'Assignee not found.', 404);
  invalidateDeskCache(workspaceId);
}

export async function addAssignee(
  workspaceId: string,
  input: { name: string; email: string; tag?: string },
) {
  const tag = ['recommended', 'alternative', 'not_recommended'].includes(input.tag ?? '')
    ? input.tag!
    : 'alternative';
  invalidateDeskCache(workspaceId);
  return prisma.meetingAssignee.upsert({
    where: { workspaceId_email: { workspaceId, email: input.email.trim().toLowerCase() } },
    create: {
      workspaceId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      tag,
    },
    update: { name: input.name.trim(), tag },
  });
}

/**
 * Seeds the workspace roster with the full team from the webapp's assignment
 * desk (limits mirrored where visible there). Idempotent: skipDuplicates
 * means existing rows — including operator edits — are never overwritten.
 */
export async function seedDefaultAssignees(workspaceId: string) {
  const defaults: Array<{ name: string; email: string; tag: string; limit?: number }> = [
    { name: 'Aalind S', email: 'aalind.singh@emergence.com', tag: 'alternative' },
    { name: 'Akash L', email: 'akash@emergence.com', tag: 'alternative' },
    { name: 'Alex E', email: 'alexandra@emergence.com', tag: 'not_recommended' },
    { name: 'Ashok K', email: 'ashok@emergence.com', tag: 'not_recommended', limit: 15 },
    { name: 'Caleb H', email: 'caleb@emergence.com', tag: 'recommended' },
    { name: 'Edwin L', email: 'edwin@emergence.com', tag: 'alternative' },
    { name: 'Henry Z', email: 'henry@emergence.com', tag: 'alternative' },
    { name: 'Hudson K', email: 'hudson@emergence.com', tag: 'recommended' },
    { name: 'Hugh M', email: 'hugh@emergence.com', tag: 'not_recommended', limit: 10 },
    { name: 'Kail W', email: 'kail@emergence.com', tag: 'not_recommended' },
    { name: 'Kapil K', email: 'kapil@emergence.com', tag: 'not_recommended', limit: 10 },
    { name: 'Karan P', email: 'karan@emergence.com', tag: 'not_recommended' },
    { name: 'Matt G', email: 'matt@emergence.com', tag: 'recommended' },
    { name: 'Matthew Turner', email: 'matthew.turner@emergence.com', tag: 'recommended' },
    { name: 'Nico T', email: 'nico@emergence.com', tag: 'recommended', limit: 30 },
    { name: 'Nolan S', email: 'nolan@emergence.com', tag: 'alternative', limit: 0 },
    { name: 'Rich S', email: 'rich@emergence.com', tag: 'recommended' },
    { name: 'Sean G', email: 'sean@emergence.com', tag: 'recommended' },
    { name: 'Shiva B', email: 'shiva@emergence.com', tag: 'not_recommended' },
    { name: 'Sourcing Cloud', email: 'sourcing@emergence.com', tag: 'recommended' },
    { name: 'Tyler C', email: 'tyler@emergence.com', tag: 'recommended' },
  ];
  await prisma.meetingAssignee.createMany({
    data: defaults.map((d) => ({
      workspaceId,
      name: d.name,
      email: d.email,
      tag: d.tag,
      weeklyMeetingLimit: d.limit ?? 50,
    })),
    skipDuplicates: true,
  });
}

// ---------------------------------------------------------------------------
// In-app meeting booking (SXP-90): create the Google Calendar event with a
// Meet link and guests, then create the Salesforce Opportunity — the same two
// steps the Emergence webapp's "Schedule Meeting" performs.
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD advanced by `days` (calendar arithmetic, tz-agnostic). */
function addDaysToCalendarDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

export interface CreateEventInput {
  title: string;
  /** YYYY-MM-DD in `timeZone`. */
  date: string;
  /** Minutes after midnight in `timeZone`. */
  startMinutes: number;
  durationMinutes: number;
  timeZone: string;
  attendeeEmails: string[];
  description?: string;
}

export interface CreatedEvent {
  eventId: string;
  htmlLink: string;
  meetLink: string | null;
  start: string;
  end: string;
}

export async function createMeetingEvent(input: CreateEventInput): Promise<CreatedEvent> {
  if (!env.MEETING_BOOKING_READY) {
    throw new AppError(
      'validation_error',
      'In-app booking is not configured (missing meeting-owner Google credentials).',
      400,
    );
  }
  const startH = Math.floor(input.startMinutes / 60);
  const startM = input.startMinutes % 60;
  const endTotal = input.startMinutes + input.durationMinutes;
  const endDayOffset = Math.floor(endTotal / (24 * 60));
  const endH = Math.floor((endTotal % (24 * 60)) / 60);
  const endM = endTotal % 60;
  const startLocal = `${input.date}T${pad2(startH)}:${pad2(startM)}:00`;
  const endLocal = `${addDaysToCalendarDate(input.date, endDayOffset)}T${pad2(endH)}:${pad2(endM)}:00`;

  const owner = env.GOOGLE_MEETING_OWNER.toLowerCase();
  const attendees = Array.from(
    new Set(
      input.attendeeEmails
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && e !== owner),
    ),
  );

  const calendar = meetingOwnerCalendar();
  const created = await calendar.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: input.title,
      description: input.description,
      start: { dateTime: startLocal, timeZone: input.timeZone },
      end: { dateTime: endLocal, timeZone: input.timeZone },
      attendees: attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `reply-dashboard-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });
  const e = created.data;
  const meetLink =
    (e.conferenceData?.entryPoints ?? []).find((p) => p.entryPointType === 'video')?.uri ??
    e.hangoutLink ??
    null;
  return {
    eventId: e.id ?? '',
    htmlLink: e.htmlLink ?? '',
    meetLink,
    start: e.start?.dateTime ?? e.start?.date ?? startLocal,
    end: e.end?.dateTime ?? e.end?.date ?? endLocal,
  };
}

export interface BookMeetingInput {
  conversationId: string;
  assigneeId: string;
  title: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  timeZone: string;
}

export interface BookMeetingResult {
  event: CreatedEvent;
  opportunity: CreateOpportunityResult;
  assignee: { id: string; name: string; email: string };
  prospectEmail: string;
}

/**
 * Book a meeting for a conversation: create the calendar event (guests = the
 * prospect + the assigned team member; Google Meet link auto-generated), then
 * best-effort create the Salesforce Opportunity for the prospect's account.
 * The prospect is whoever sent the newest inbound reply.
 */
export async function bookMeeting(
  workspaceId: string,
  input: BookMeetingInput,
): Promise<BookMeetingResult> {
  const latestInbound = await prisma.message.findFirst({
    where: {
      conversationId: input.conversationId,
      direction: 'inbound',
      conversation: { workspaceId },
    },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    select: { fromEmail: true, fromName: true },
  });
  if (!latestInbound) {
    throw new AppError('not_found', 'No inbound reply on this conversation.', 404);
  }
  const assignee = await prisma.meetingAssignee.findFirst({
    where: { id: input.assigneeId, workspaceId },
  });
  if (!assignee) throw new AppError('not_found', 'Assignee not found.', 404);

  const event = await createMeetingEvent({
    title: input.title,
    date: input.date,
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
    timeZone: input.timeZone,
    attendeeEmails: [latestInbound.fromEmail, assignee.email],
    description: 'Scheduled from the Reply Dashboard.',
  });

  let opportunity: CreateOpportunityResult = {
    status: 'skipped',
    reason: 'salesforce_not_configured',
  };
  if (env.SF_READY) {
    const ctx = await getSalesforceContext(latestInbound.fromEmail);
    if (ctx.account) {
      opportunity = await createOpportunity({
        accountId: ctx.account.id,
        sourcingLeadName: assignee.name,
        topContactName: ctx.person?.name ?? latestInbound.fromName ?? latestInbound.fromEmail,
        topContactEmail: ctx.person?.email ?? latestInbound.fromEmail,
      });
    } else {
      opportunity = { status: 'skipped', reason: 'no_salesforce_account' };
    }
  }

  return {
    event,
    opportunity,
    assignee: { id: assignee.id, name: assignee.name, email: assignee.email },
    prospectEmail: latestInbound.fromEmail,
  };
}

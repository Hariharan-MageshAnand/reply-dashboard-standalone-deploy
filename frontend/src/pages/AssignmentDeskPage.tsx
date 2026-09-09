import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar';
import {
  conversationApi,
  meetingApi,
  type BookMeetingResult,
  type DeskAssignee,
} from '../lib/services';

const TZ_OPTIONS = [
  { key: 'PT', tz: 'America/Los_Angeles' },
  { key: 'ET', tz: 'America/New_York' },
  { key: 'IST', tz: 'Asia/Kolkata' },
] as const;
type TzKey = (typeof TZ_OPTIONS)[number]['key'];

const DURATIONS = [30, 45, 60] as const;
const PX_PER_HOUR = 44;
// The desk/calendar routes accept only weeks in [-8, 8] (zod .min(-8).max(8)).
// Keep navigation inside that range so we never fire a request the API 400s.
const WEEK_MIN = -8;
const WEEK_MAX = 8;

function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUtc - at.getTime();
}

/** UTC instant for y/m/d + minutes-after-midnight in a timezone. */
function zonedToUtc(y: number, m: number, d: number, minutes: number, tz: string): Date {
  let t = Date.UTC(y, m - 1, d, 0, minutes);
  for (let i = 0; i < 3; i += 1) {
    const next = Date.UTC(y, m - 1, d, 0, minutes) - tzOffsetMs(tz, new Date(t));
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}

function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function gcalStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const TAG_LABELS: Record<string, { text: string; className: string }> = {
  recommended: { text: 'Recommended', className: 'badge badge-ok' },
  alternative: { text: 'Alternative', className: 'badge' },
  not_recommended: { text: 'Not recommended', className: 'badge badge-warn' },
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function availability(a: DeskAssignee): { label: string; full: boolean; muted: boolean } {
  if (a.meetingsThisWeek === null) return { label: 'N/A', full: false, muted: true };
  if (a.weeklyMeetingLimit === 0)
    return { label: `${a.meetingsThisWeek} this wk`, full: false, muted: false };
  if (a.meetingsThisWeek >= a.weeklyMeetingLimit) return { label: 'Full', full: true, muted: false };
  return { label: `${a.meetingsThisWeek} / ${a.weeklyMeetingLimit}`, full: false, muted: false };
}

export function AssignmentDeskPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const conversationId = params.get('conversation');
  const [week, setWeek] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftLimit, setDraftLimit] = useState('');
  const [step, setStep] = useState<'desk' | 'calendar'>('desk');

  const desk = useQuery({
    queryKey: ['meeting-desk', week],
    queryFn: () => meetingApi.desk(week),
    staleTime: 60_000,
  });

  const assignees = useMemo(() => desk.data?.assignees ?? [], [desk.data?.assignees]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assignees.filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q),
    );
  }, [assignees, search]);
  const selected = assignees.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    setDraftLimit(selected ? String(selected.weeklyMeetingLimit) : '');
  }, [selected?.id, selected?.weeklyMeetingLimit]);

  const saveLimit = useMutation({
    mutationFn: async ({ id, limit }: { id: string; limit: number }) =>
      meetingApi.updateLimit(id, limit),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['meeting-desk'] });
    },
  });

  const parsedLimit = Number(draftLimit);
  const limitValid = draftLimit.trim() !== '' && Number.isInteger(parsedLimit) && parsedLimit >= 0;
  const limitChanged = selected !== null && limitValid && parsedLimit !== selected.weeklyMeetingLimit;
  const selectedTag = selected ? (TAG_LABELS[selected.tag] ?? TAG_LABELS.alternative) : null;

  return (
    <div className="app-shell" style={{ gridTemplateColumns: '190px 1fr' }}>
      <Sidebar />
      <main style={{ padding: '22px 26px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="muted" style={{ fontSize: 10.5, letterSpacing: '0.1em', fontWeight: 700, textTransform: 'uppercase' }}>
              Weekly assignment
            </div>
            <h1 className="display-title" style={{ margin: '2px 0 0', fontSize: 24 }}>
              Assignment desk
            </h1>
            <p className="muted" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
              Review capacity, set a weekly limit, then assign the lead.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {conversationId && (
              <button type="button" className="btn btn-ghost" style={{ minHeight: 32, fontSize: 13 }} onClick={() => navigate(`/inbox/${conversationId}`)}>
                Back to thread
              </button>
            )}
            <button type="button" className="btn btn-secondary" style={{ minHeight: 30, paddingInline: 9 }} disabled={week <= WEEK_MIN} onClick={() => setWeek((w) => Math.max(WEEK_MIN, w - 1))} aria-label="Previous week">
              <ChevronLeft size={14} />
            </button>
            <div style={{ textAlign: 'center', minWidth: 118 }}>
              <div className="muted" style={{ fontSize: 10, letterSpacing: '0.09em', fontWeight: 700 }}>
                {week === 0 ? 'THIS WEEK' : week > 0 ? `IN ${week} WEEK${week > 1 ? 'S' : ''}` : `${-week} WEEK${week < -1 ? 'S' : ''} AGO`}
              </div>
              <strong style={{ fontSize: 12.5 }}>{desk.data?.weekLabel ?? '…'}</strong>
            </div>
            <button type="button" className="btn btn-secondary" style={{ minHeight: 30, paddingInline: 9 }} disabled={week >= WEEK_MAX} onClick={() => setWeek((w) => Math.min(WEEK_MAX, w + 1))} aria-label="Next week">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        {desk.data && !desk.data.ready && (
          <p className="muted" style={{ marginTop: 18 }}>
            Calendar is not configured on the server (Google service account missing).
          </p>
        )}

        {step === 'calendar' && selected && (
          <CalendarStep
            assignee={selected}
            week={week}
            conversationId={conversationId}
            onBack={() => setStep('desk')}
          />
        )}

        {step === 'desk' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(340px, 1fr) 310px',
            gap: 14,
            marginTop: 16,
            alignItems: 'stretch',
            flex: 1,
            minHeight: 0,
          }}
        >
          <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <Search size={13} style={{ position: 'absolute', left: 11, top: 12, opacity: 0.45 }} aria-hidden />
              <input
                className="input"
                style={{ minHeight: 36, paddingLeft: 30, fontSize: 13 }}
                placeholder="Search by name or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
              {desk.isLoading && <p className="muted" style={{ padding: 10, margin: 0 }}>Loading calendars…</p>}
              {visible.map((a) => {
                const avail = availability(a);
                const tag = TAG_LABELS[a.tag] ?? TAG_LABELS.alternative;
                const isSelected = selectedId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedId(a.id)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '9px 10px',
                      border: 0,
                      borderBottom: '1px solid var(--border-soft)',
                      borderRadius: isSelected ? 8 : 0,
                      background: isSelected ? 'rgba(107, 145, 55, 0.13)' : 'transparent',
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 650, fontSize: 13 }}>{a.name}</span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3, flexWrap: 'wrap' }}>
                        <span className="muted" style={{ fontSize: 11.5 }}>{a.email}</span>
                        <span className={tag.className} style={{ fontSize: 10, padding: '1px 7px' }}>{tag.text}</span>
                      </span>
                    </span>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 12,
                        color: avail.full ? 'var(--danger)' : avail.muted ? 'var(--muted-foreground)' : 'var(--foreground)',
                        flexShrink: 0,
                      }}
                      title={a.calendarError ?? undefined}
                    >
                      {avail.label}
                    </span>
                  </button>
                );
              })}
              {!desk.isLoading && visible.length === 0 && (
                <p className="muted" style={{ padding: 10 }}>No team members match.</p>
              )}
            </div>
          </div>

          <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'start' }}>
            {!selected && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Select a team member to review capacity.</p>}
            {selected && (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      background: 'var(--muted)',
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 700,
                      fontSize: 12.5,
                      flexShrink: 0,
                    }}
                  >
                    {initials(selected.name)}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ fontSize: 13.5 }}>{selected.name}</strong>
                    <div className="muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>{selected.email}</div>
                  </div>
                  {selectedTag && (
                    <span className={selectedTag.className} style={{ fontSize: 10.5, flexShrink: 0 }}>
                      {selectedTag.text}
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="card" style={{ padding: '10px 12px' }}>
                    <div className="muted" style={{ fontSize: 10, letterSpacing: '0.08em', fontWeight: 700 }}>THIS WEEK</div>
                    <strong style={{ fontSize: 14.5 }}>
                      {selected.meetingsThisWeek === null
                        ? 'N/A'
                        : `${selected.meetingsThisWeek} meeting${selected.meetingsThisWeek === 1 ? '' : 's'}`}
                    </strong>
                  </div>
                  <div className="card" style={{ padding: '10px 12px' }}>
                    <div className="muted" style={{ fontSize: 10, letterSpacing: '0.08em', fontWeight: 700 }}>CAPACITY</div>
                    <strong style={{ fontSize: 14.5 }}>
                      {selected.weeklyMeetingLimit === 0 ? 'On demand' : `${selected.weeklyMeetingLimit} / week`}
                    </strong>
                  </div>
                </div>

                {selected.calendarError && (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>
                    Calendar unavailable: {selected.calendarError}
                  </p>
                )}

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 12.5 }}>Weekly meeting limit</strong>
                    {parsedLimit === 0 && limitValid && (
                      <span className="muted" style={{ fontSize: 11, fontWeight: 700 }}>On Demand</span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, margin: '2px 0 7px' }}>
                    Use 0 for On Demand.
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ minHeight: 40, paddingInline: 15, fontSize: 16 }}
                      onClick={() => setDraftLimit(String(Math.max(0, (limitValid ? parsedLimit : 0) - 1)))}
                      aria-label="Decrease limit"
                    >
                      −
                    </button>
                    <input
                      className="input"
                      style={{ minHeight: 40, textAlign: 'center', fontSize: 15, fontWeight: 600, flex: 1 }}
                      value={draftLimit}
                      onChange={(e) => setDraftLimit(e.target.value.replace(/[^0-9]/g, ''))}
                      aria-label="Weekly meeting limit"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ minHeight: 40, paddingInline: 15, fontSize: 16 }}
                      onClick={() => setDraftLimit(String((limitValid ? parsedLimit : 0) + 1))}
                      aria-label="Increase limit"
                    >
                      +
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  className={limitChanged ? 'btn btn-primary' : 'btn btn-secondary'}
                  style={{ width: '100%' }}
                  disabled={!limitChanged || saveLimit.isPending}
                  onClick={() => selected && saveLimit.mutate({ id: selected.id, limit: parsedLimit })}
                >
                  {saveLimit.isPending ? 'Saving…' : 'Save limit'}
                </button>
              </>
            )}
          </div>
        </div>
        )}

        {step === 'desk' && (
        <button
          type="button"
          className="btn"
          disabled={!selected}
          title={selected ? undefined : 'Select a team member first'}
          onClick={() => setStep('calendar')}
          style={{
            width: '100%',
            marginTop: 14,
            minHeight: 44,
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            fontWeight: 650,
            opacity: selected ? 1 : 0.55,
          }}
        >
          Continue to calendar →
        </button>
        )}
      </main>
    </div>
  );
}

function CalendarStep({
  assignee,
  week,
  conversationId,
  onBack,
}: {
  assignee: DeskAssignee;
  week: number;
  conversationId: string | null;
  onBack: () => void;
}) {
  const [tzKey, setTzKey] = useState<TzKey>('PT');
  const [presetDuration, setPresetDuration] = useState<number>(30);
  const [customActive, setCustomActive] = useState(false);
  const [customMin, setCustomMin] = useState('90');
  const [slot, setSlot] = useState<{ day: number; startMin: number } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const qc = useQueryClient();
  const [booked, setBooked] = useState<BookMeetingResult | null>(null);

  const tz = TZ_OPTIONS.find((t) => t.key === tzKey)!.tz;
  const customParsed = Number(customMin);
  const duration = customActive
    ? Math.max(15, Math.min(240, Number.isInteger(customParsed) && customParsed > 0 ? customParsed : 30))
    : presetDuration;

  const calendar = useQuery({
    queryKey: ['assignee-calendar', assignee.id, week],
    queryFn: () => meetingApi.assigneeCalendar(assignee.id, week),
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => conversationApi.get(conversationId!),
    enabled: Boolean(conversationId),
    staleTime: 5 * 60_000,
  });

  const salesforce = useQuery({
    queryKey: ['salesforce', conversationId],
    queryFn: () => conversationApi.salesforce(conversationId!),
    enabled: Boolean(conversationId),
    staleTime: 5 * 60_000,
  });

  const monday = useMemo(() => {
    if (!calendar.data?.weekStart) return null;
    const d = new Date(calendar.data.weekStart);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(d);
    const o = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return { y: Number(o.year), m: Number(o.month), d: Number(o.day) };
  }, [calendar.data?.weekStart]);

  const dayStarts = useMemo(() => {
    if (!monday) return [] as Date[];
    return Array.from({ length: 7 }, (_, i) => zonedToUtc(monday.y, monday.m, monday.d + i, 0, tz));
  }, [monday, tz]);

  const dayLabels = useMemo(() => {
    return dayStarts.map((start) => {
      const mid = new Date(start.getTime() + 12 * 3_600_000);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
      }).formatToParts(mid);
      const o = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      return { weekday: String(o.weekday ?? '').toUpperCase(), day: o.day ?? '' };
    });
  }, [dayStarts, tz]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 7 * PX_PER_HOUR;
  }, [calendar.data?.weekStart]);

  useEffect(() => {
    setSlot(null);
    setCustomTitle(null);
    setEditingTitle(false);
    setBooked(null);
  }, [week, assignee.id]);

  const events = calendar.data?.events ?? [];
  const timed = events.filter((e) => !e.isAllDay);
  const allDay = events.filter((e) => e.isAllDay);
  const busyCount = events.filter((e) => e.busy).length;

  const blocksForDay = (i: number) => {
    if (!dayStarts.length) return [];
    const dayStart = dayStarts[i].getTime();
    const dayEnd = dayStart + 86_400_000;
    const out: Array<{ key: string; top: number; height: number; label: string; busy: boolean; summary: string }> = [];
    for (const ev of timed) {
      const s = new Date(ev.start).getTime();
      const e = new Date(ev.end).getTime();
      const os = Math.max(s, dayStart);
      const oe = Math.min(e, dayEnd);
      if (oe <= os) continue;
      const topMin = (os - dayStart) / 60_000;
      out.push({
        key: `${ev.id}-${i}`,
        top: (topMin / 60) * PX_PER_HOUR,
        height: Math.max(13, (((oe - os) / 60_000) / 60) * PX_PER_HOUR - 2),
        label: fmtTime(topMin).replace(':00', '').replace(' ', '').toLowerCase(),
        busy: ev.busy,
        summary: ev.summary,
      });
    }
    return out;
  };

  const allDayForDay = (i: number) => {
    if (!monday) return [] as typeof allDay;
    const dayStr = new Date(Date.UTC(monday.y, monday.m - 1, monday.d + i)).toISOString().slice(0, 10);
    return allDay.filter((ev) => ev.start <= dayStr && dayStr < ev.end);
  };

  const slotStart = slot && monday ? zonedToUtc(monday.y, monday.m, monday.d + slot.day, slot.startMin, tz) : null;
  const slotEnd = slotStart ? new Date(slotStart.getTime() + duration * 60_000) : null;
  const slotLabel = slot ? `${fmtTime(slot.startMin)} - ${fmtTime(slot.startMin + duration)} ${tzKey}` : null;

  const prospect = detail.data?.participants.find((p) => p.role === 'from') ?? null;
  const sfMatch = salesforce.data?.match ?? null;
  const company =
    salesforce.data?.account?.name ??
    sfMatch?.company ??
    prospect?.name?.split(' ')[0] ??
    prospect?.email?.split('@')[0] ??
    'Meeting';
  const meetingTitle = customTitle ?? `${company} & Emergence`;

  const gcalUrl =
    slotStart && slotEnd
      ? `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(meetingTitle)}&dates=${gcalStamp(slotStart)}/${gcalStamp(slotEnd)}&add=${encodeURIComponent([assignee.email, prospect?.email].filter(Boolean).join(','))}`
      : null;

  // Calendar date (YYYY-MM-DD) of the selected slot, in the chosen timezone.
  const bookingDate =
    slotStart && slot
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(slotStart)
      : null;

  const book = useMutation({
    mutationFn: () =>
      meetingApi.book({
        conversationId: conversationId!,
        assigneeId: assignee.id,
        title: meetingTitle,
        date: bookingDate!,
        startMinutes: slot!.startMin,
        durationMinutes: duration,
        timeZone: tz,
      }),
    onSuccess: (result) => {
      setBooked(result);
      void qc.invalidateQueries({ queryKey: ['assignee-calendar', assignee.id] });
      void qc.invalidateQueries({ queryKey: ['meeting-desk'] });
      void qc.invalidateQueries({ queryKey: ['salesforce', conversationId] });
    },
  });

  const canBook = Boolean(conversationId && slot && bookingDate) && !book.isPending;

  const handleBook = () => {
    if (!canBook) return;
    book.mutate();
  };

  const pickSlot = (dayIdx: number, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const raw = Math.floor(((y / PX_PER_HOUR) * 60) / 30) * 30;
    const startMin = Math.max(0, Math.min(24 * 60 - duration, raw));
    setSlot({ day: dayIdx, startMin });
    setBooked(null);
    book.reset();
  };

  const groupBtn = (active: boolean): React.CSSProperties => ({
    minHeight: 28,
    paddingInline: 10,
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 8,
    border: '1px solid var(--border-soft)',
    background: active ? 'var(--primary)' : 'transparent',
    color: active ? 'var(--primary-foreground)' : 'var(--foreground)',
    cursor: 'pointer',
  });

  const guestCount = 2 + (prospect?.email ? 1 : 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" style={{ minHeight: 30, paddingInline: 8 }} onClick={onBack} aria-label="Back to assignment desk">
          <ChevronLeft size={15} />
        </button>
        <span style={{ fontSize: 13 }}>
          <strong>{assignee.name}</strong>
          <span className="muted"> · click grid to select</span>
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {TZ_OPTIONS.map((t) => (
              <button key={t.key} type="button" style={groupBtn(tzKey === t.key)} onClick={() => { setTzKey(t.key); setSlot(null); }}>
                {t.key}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                style={groupBtn(!customActive && presetDuration === d)}
                onClick={() => { setCustomActive(false); setPresetDuration(d); }}
              >
                {d}m
              </button>
            ))}
            <button type="button" style={groupBtn(customActive)} onClick={() => setCustomActive(true)}>
              Custom
            </button>
            {customActive && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-soft)', borderRadius: 8, padding: '2px 8px' }}>
                <input
                  type="number"
                  min={15}
                  max={240}
                  step={1}
                  value={customMin}
                  onChange={(e) => setCustomMin(e.target.value)}
                  aria-label="Custom duration in minutes"
                  style={{ width: 46, border: 0, background: 'transparent', font: 'inherit', fontWeight: 700, fontSize: 13, textAlign: 'center' }}
                />
                <span className="muted" style={{ fontSize: 11.5 }}>min</span>
              </span>
            )}
          </div>
          <strong style={{ fontSize: 12.5 }}>{slotLabel ?? 'No time selected'}</strong>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '8px 0 6px', fontSize: 11.5 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(107,145,55,0.15)', border: '1px solid var(--border-soft)' }} /> Events
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'repeating-linear-gradient(45deg, rgba(107,145,55,0.25) 0 3px, transparent 3px 6px)', border: '1px solid var(--border-soft)' }} /> Busy
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--primary)' }} /> Selected
        </span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {calendar.isLoading ? 'Loading calendar…' : `${events.length} event${events.length === 1 ? '' : 's'} · ${busyCount} busy`}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 340 }}>
        <div className="card" style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '46px repeat(7, 1fr)', borderBottom: '1px solid var(--border-soft)', background: 'var(--sidebar)' }}>
            <div />
            {dayLabels.map((d, i) => (
              <div key={i} style={{ textAlign: 'center', padding: '7px 0', borderLeft: '1px solid var(--border-soft)' }}>
                <div className="muted" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em' }}>{d.weekday}</div>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{d.day}</div>
              </div>
            ))}
          </div>
          <div ref={gridRef} style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '46px repeat(7, 1fr)', height: 24 * PX_PER_HOUR }}>
              <div style={{ position: 'relative' }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="muted" style={{ position: 'absolute', top: h * PX_PER_HOUR - 6, right: 6, fontSize: 9.5, fontWeight: 600 }}>
                    {h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}
                  </div>
                ))}
              </div>
              {Array.from({ length: 7 }, (_, i) => (
                <div
                  key={i}
                  onClick={(e) => pickSlot(i, e)}
                  style={{
                    position: 'relative',
                    borderLeft: '1px solid var(--border-soft)',
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${PX_PER_HOUR - 1}px, var(--border-soft) ${PX_PER_HOUR - 1}px ${PX_PER_HOUR}px)`,
                    cursor: 'pointer',
                  }}
                >
                  {allDayForDay(i).map((ev) => (
                    <div
                      key={`${ev.id}-${i}`}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'repeating-linear-gradient(45deg, rgba(107,145,55,0.10) 0 5px, transparent 5px 10px)',
                        pointerEvents: 'none',
                      }}
                    >
                      <span className="muted" style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 4px', display: 'inline-block' }}>
                        {ev.summary}
                      </span>
                    </div>
                  ))}
                  {blocksForDay(i).map((b) => (
                    <div
                      key={b.key}
                      title={b.summary}
                      style={{
                        position: 'absolute',
                        top: b.top,
                        height: b.height,
                        left: 2,
                        right: 2,
                        borderRadius: 4,
                        border: '1px solid rgba(107,145,55,0.45)',
                        background: b.busy
                          ? 'repeating-linear-gradient(45deg, rgba(107,145,55,0.22) 0 4px, rgba(107,145,55,0.06) 4px 8px)'
                          : 'rgba(107,145,55,0.12)',
                        overflow: 'hidden',
                        pointerEvents: 'none',
                      }}
                    >
                      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--foreground)', opacity: 0.75, padding: '1px 3px', display: 'inline-block' }}>
                        {b.label}
                      </span>
                    </div>
                  ))}
                  {slot?.day === i && (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={(e) => { e.stopPropagation(); setPreviewOpen(true); }}
                        style={{
                          position: 'absolute',
                          top: Math.max(2, (slot.startMin / 60) * PX_PER_HOUR - 32),
                          left: '50%',
                          transform: 'translateX(-50%)',
                          minHeight: 27,
                          paddingInline: 10,
                          fontSize: 12,
                          zIndex: 5,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Confirm time
                      </button>
                      <div
                        style={{
                          position: 'absolute',
                          top: (slot.startMin / 60) * PX_PER_HOUR,
                          height: (duration / 60) * PX_PER_HOUR,
                          left: 2,
                          right: 2,
                          borderRadius: 4,
                          border: '2px solid var(--primary)',
                          background: 'rgba(107,145,55,0.25)',
                          zIndex: 4,
                          pointerEvents: 'none',
                        }}
                      >
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 4px', display: 'inline-block' }}>
                          {fmtTime(slot.startMin).toLowerCase().replace(' ', '')}–{fmtTime(slot.startMin + duration).toLowerCase().replace(' ', '')}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {!previewOpen && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPreviewOpen(true)}
            aria-label="Open preview"
            style={{ alignSelf: 'center', minHeight: 44, paddingInline: 6 }}
          >
            <ChevronLeft size={15} />
          </button>
        )}

        {previewOpen && (
          <aside className="card" style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--card-solid)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', borderBottom: '1px solid var(--border-soft)' }}>
              <strong style={{ fontSize: 13.5 }}>Preview</strong>
              <button type="button" className="btn btn-ghost" style={{ minHeight: 24, paddingInline: 6 }} onClick={() => setPreviewOpen(false)} aria-label="Close preview">
                ✕
              </button>
            </div>
            <div style={{ padding: 14, display: 'grid', gap: 13, overflowY: 'auto', flex: 1, minHeight: 0, alignContent: 'start', fontSize: 12.5 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--primary)', marginTop: 3, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  {editingTitle ? (
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <input
                        className="input"
                        autoFocus
                        style={{ minHeight: 30, fontSize: 13, flex: 1 }}
                        value={customTitle ?? meetingTitle}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setEditingTitle(false);
                          if (e.key === 'Escape') {
                            setCustomTitle(null);
                            setEditingTitle(false);
                          }
                        }}
                        aria-label="Meeting title"
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ minHeight: 30, paddingInline: 9, fontSize: 12 }}
                        onClick={() => setEditingTitle(false)}
                      >
                        Done
                      </button>
                    </div>
                  ) : (
                    <strong style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {meetingTitle}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ minHeight: 20, paddingInline: 4, fontSize: 11 }}
                        title="Edit meeting title"
                        onClick={() => setEditingTitle(true)}
                      >
                        ✎
                      </button>
                    </strong>
                  )}
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {slot && slotLabel
                      ? `${dayLabels[slot.day]?.weekday ?? ''} ${dayLabels[slot.day]?.day ?? ''} · ${slotLabel} · ${duration} min`
                      : 'Select a time on the calendar'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span aria-hidden style={{ fontSize: 14 }}>📹</span>
                  <div>
                    <div style={{ color: 'var(--primary)', fontWeight: 650 }}>Join with Google Meet</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>Link is generated when the meeting is scheduled</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span aria-hidden style={{ fontSize: 13 }}>✆</span>
                  <div className="muted">Join by phone · available after scheduling</div>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 650 }}>{guestCount} guests</div>
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 7 }}>1 yes · {guestCount - 1} awaiting</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="msg-avatar" aria-hidden style={{ width: 26, height: 26, fontSize: 11 }}>E</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>Emergence Meeting ✓</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>Meeting owner · meeting@emergence.com</div>
                    </div>
                  </div>
                  {prospect && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="msg-avatar" aria-hidden style={{ width: 26, height: 26, fontSize: 11 }}>
                        {(prospect.name ?? prospect.email ?? '?').charAt(0).toUpperCase()}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{prospect.name ?? prospect.email}</div>
                        <div className="muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>
                          {[sfMatch?.title, prospect.email].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="msg-avatar" aria-hidden style={{ width: 26, height: 26, fontSize: 11 }}>{initials(assignee.name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{assignee.name}</div>
                      <div className="muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>
                        Sourcing Lead · {assignee.email}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span aria-hidden style={{ fontSize: 12 }}>🗓</span> Emsoft Meeting
                </div>
                <div className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span aria-hidden style={{ fontSize: 12 }}>🔒</span> Public
                </div>
              </div>
            </div>
            <div style={{ padding: 12, borderTop: '1px solid var(--border-soft)', display: 'grid', gap: 8 }}>
              {booked ? (
                <BookingResult booked={booked} />
              ) : (
                <>
                  {book.isError && (
                    <div
                      className="badge badge-warn"
                      style={{ display: 'block', fontSize: 11.5, lineHeight: 1.35, padding: '7px 9px', whiteSpace: 'normal' }}
                    >
                      {(book.error as Error)?.message ?? 'Booking failed.'}
                      {gcalUrl && (
                        <>
                          {' '}
                          <a href={gcalUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
                            Open in Google Calendar instead
                          </a>
                        </>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={!canBook}
                    onClick={handleBook}
                    title={
                      !conversationId
                        ? 'Open this from a conversation to book in-app'
                        : slot
                          ? 'Creates the Google Calendar invite (with Meet link) and a Salesforce opportunity'
                          : 'Select a time on the calendar first'
                    }
                    style={{
                      width: '100%',
                      minHeight: 40,
                      background: 'var(--primary)',
                      color: 'var(--primary-foreground)',
                      fontWeight: 650,
                      opacity: canBook ? 1 : 0.55,
                    }}
                  >
                    {book.isPending ? 'Scheduling…' : '🗓 Schedule Meeting'}
                  </button>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function opportunityNote(opportunity: BookMeetingResult['opportunity']): string {
  switch (opportunity.status) {
    case 'created':
      return `Salesforce opportunity created — ${opportunity.name}`;
    case 'skipped':
      if (opportunity.reason === 'opportunity_already_exists')
        return 'Salesforce: an open opportunity already exists on this account.';
      if (opportunity.reason === 'account_claimed_by_other')
        return `Salesforce: account is already claimed by ${opportunity.claimedBy ?? 'another lead'}.`;
      if (opportunity.reason === 'no_salesforce_account')
        return 'Salesforce: no matched account, so no opportunity was created.';
      return 'Salesforce: opportunity not created.';
    case 'error':
      return `Salesforce opportunity failed: ${opportunity.message}`;
    default:
      return '';
  }
}

function BookingResult({ booked }: { booked: BookMeetingResult }) {
  const oppOk = booked.opportunity.status === 'created';
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontWeight: 650, fontSize: 13 }}>
        <span aria-hidden style={{ color: 'var(--primary)' }}>✓</span> Meeting scheduled — invites sent
      </div>
      <div style={{ display: 'grid', gap: 5, fontSize: 12 }}>
        {booked.event.meetLink && (
          <a href={booked.event.meetLink} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
            Join with Google Meet
          </a>
        )}
        {booked.event.htmlLink && (
          <a href={booked.event.htmlLink} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
            Open event in Google Calendar
          </a>
        )}
        <div className="muted" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', lineHeight: 1.35 }}>
          <span aria-hidden>{oppOk ? '✓' : '•'}</span>
          <span>{opportunityNote(booked.opportunity)}</span>
        </div>
      </div>
    </div>
  );
}

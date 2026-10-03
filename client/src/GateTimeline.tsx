import { useMemo } from 'react';

type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup' | 'dropoff'; windowStart: string; windowEnd: string; lane: 'north' | 'south' | 'rail'; status: string; exception?: string };
type Conflict = { severity: string; kind: 'overlap' | 'short-gap' | 'customs'; appointmentId: string; otherId?: string; reason: string };

type Zone = { start: number; end: number; kind: 'overlap' | 'short-gap' };

const pad = (value: number) => String(value).padStart(2, '0');
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clock = (value: string | number) => { const d = new Date(value); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fullRange = (a: Appointment) => { const s = new Date(a.windowStart), e = new Date(a.windowEnd); const sameDay = dayKey(s.getTime()) === dayKey(e.getTime()); return `${s.getMonth() + 1}/${s.getDate()} ${pad(s.getHours())}:${pad(s.getMinutes())} → ${sameDay ? '' : `${e.getMonth() + 1}/${e.getDate()} `}${pad(e.getHours())}:${pad(e.getMinutes())}`; };
const LANE_NAME: Record<string, string> = { north: '北闸口', south: '南闸口', rail: '铁路闸口' };
const STATUS_META: Record<string, { label: string; glyph: string }> = {
  booked: { label: '已预约', glyph: '◷' },
  'checked-in': { label: '已签到', glyph: '✓' },
  completed: { label: '已完成', glyph: '✔' },
  cancelled: { label: '已取消', glyph: '✕' },
  exception: { label: '异常', glyph: '!' },
};

type Props = {
  appointments: Appointment[];
  conflicts: Conflict[];
  onEdit: (appointment: Appointment) => void;
};

export default function GateTimeline({ appointments, conflicts, onEdit }: Props) {
  const model = useMemo(() => {
    // 按车牌聚合，保留每辆车的预约时间序
    const groups = new Map<string, Appointment[]>();
    for (const a of appointments) {
      const list = groups.get(a.truckNo) ?? [];
      list.push(a); groups.set(a.truckNo, list);
    }
    for (const list of groups.values()) list.sort((x, y) => +new Date(x.windowStart) - +new Date(y.windowStart));

    // 服务端冲突区间落到预约上（重叠区 / 间隔空白区）
    const zonesById = new Map<string, Zone[]>();
    const byId = new Map(appointments.map(a => [a.id, a]));
    for (const c of conflicts) {
      if (c.kind === 'customs' || !c.otherId) continue;
      const a = byId.get(c.appointmentId), b = byId.get(c.otherId);
      if (!a || !b) continue;
      const starts = [+new Date(a.windowStart), +new Date(b.windowStart)].sort((x, y) => x - y);
      const ends = [+new Date(a.windowEnd), +new Date(b.windowEnd)].sort((x, y) => x - y);
      const zone: Zone = c.kind === 'overlap'
        ? { start: starts[1], end: ends[0], kind: 'overlap' }
        : { start: ends[0], end: starts[1], kind: 'short-gap' };
      for (const id of [a.id, b.id]) { const z = zonesById.get(id) ?? []; z.push(zone); zonesById.set(id, z); }
    }

    // 全局时间轴：取筛选结果中最早开始到最晚结束，并对齐到整点
    let rStart = Infinity, rEnd = -Infinity;
    for (const a of appointments) { rStart = Math.min(rStart, +new Date(a.windowStart)); rEnd = Math.max(rEnd, +new Date(a.windowEnd)); }
    if (!appointments.length) return undefined;
    rStart = new Date(rStart).setMinutes(0, 0, 0);
    rEnd = new Date(rEnd + 3600000).setMinutes(0, 0, 0);
    if (rEnd <= rStart) rEnd = rStart + 3600000;

    // 跨天边界与每天刻度
    const days: { key: string; label: string }[] = [];
    for (let t = new Date(rStart); t.getTime() < rEnd; t.setDate(t.getDate() + 1)) days.push({ key: dayKey(t.getTime()), label: `${t.getMonth() + 1}月${t.getDate()}日` });
    const multiDay = days.length > 1;
    const tickHours = multiDay ? [0, 6, 12, 18] : [8, 10, 12, 14, 16, 18, 20];
    const ticks: { t: number; label: string }[] = [];
    for (const day of days) {
      const [y, m, d] = day.key.split('-').map(Number);
      for (const h of tickHours) {
        const t = new Date(y, m - 1, d, h).getTime();
        if (t >= rStart && t <= rEnd) ticks.push({ t, label: multiDay && h === 0 ? day.label : `${pad(h)}:00` });
      }
    }
    const now = Date.now();
    const pct = (t: number) => ((t - rStart) / (rEnd - rStart)) * 100;

    // 分组排序：有冲突的车辆靠前，其余按最早窗口时间
    const sortedGroups = [...groups.entries()].map(([truckNo, items]) => {
      const ids = new Set(items.map(i => i.id));
      const related = conflicts.filter(c => ids.has(c.appointmentId) || (c.otherId !== undefined && ids.has(c.otherId)));
      return {
        truckNo, items, related,
        overlapCount: related.filter(c => c.kind === 'overlap').length,
        gapCount: related.filter(c => c.kind === 'short-gap').length,
        cancelledCount: items.filter(i => i.status === 'cancelled').length,
        earliest: Math.min(...items.map(i => +new Date(i.windowStart))),
      };
    }).sort((x, y) => (Number(y.overlapCount > 0 || y.gapCount > 0) - Number(x.overlapCount > 0 || x.gapCount > 0)) || x.earliest - y.earliest);

    return { rStart, rEnd, days, ticks, now, pct, sortedGroups, zonesById };
  }, [appointments, conflicts]);

  if (!appointments.length) return null;
  if (!model) return null;

  return <div className="timeline">
    <div className="tl-legend">
      <span><i className="lg-booked"/>已预约</span><span><i className="lg-checked-in"/>已签到</span><span><i className="lg-completed"/>已完成</span><span><i className="lg-cancelled"/>已取消</span>
      <span className="lg-sep"/><span><i className="lg-overlap"/>窗口重叠</span><span><i className="lg-gap"/>间隔过短 (&lt;30min)</span><span><i className="lg-cross"/>跨天窗口</span><span><i className="lg-now"/>当前时间</span>
    </div>
    <div className="tl-scroll">
      <div className="tl-canvas" style={{ minWidth: model.days.length > 1 ? `${Math.max(680, model.days.length * 420)}px` : '680px' }}>
        <div className="tl-ruler">
          {model.days.map(day => { const [y, m, d] = day.key.split('-').map(Number); const dStart = Math.max(new Date(y, m - 1, d).getTime(), model.rStart); const dEnd = Math.min(new Date(y, m - 1, d + 1).getTime(), model.rEnd); return <div key={day.key} className="tl-dayhead" style={{ left: `${model.pct(dStart)}%`, width: `${model.pct(dEnd) - model.pct(dStart)}%` }}>{model.days.length > 1 ? day.label : ''}</div>; })}
          {model.ticks.map(tick => <span key={tick.t} className="tl-tick" style={{ left: `${model.pct(tick.t)}%` }}>{tick.label}</span>)}
        </div>
        {model.now > model.rStart && model.now < model.rEnd && <div className="tl-nowline" style={{ left: `${model.pct(model.now)}%` }}><i>现在</i></div>}
        {model.sortedGroups.map(group => {
          // 重叠片段分配不同泳道，避免同车片段互相遮挡
          const lanes: Appointment[][] = [];
          for (const a of group.items) {
            const s = +new Date(a.windowStart), e = +new Date(a.windowEnd);
            let lane = lanes.find(row => row.every(o => +new Date(o.windowEnd) <= s || +new Date(o.windowStart) >= e));
            if (!lane) { lane = []; lanes.push(lane); }
            lane.push(a);
          }
          const allCancelled = group.items.every(i => i.status === 'cancelled');
          return <div className="tl-row" key={group.truckNo}>
            <div className="tl-label">
              <b>{group.truckNo}</b>
              <small>{group.items.length} 个窗口 · 司机 {group.items[0].driver}</small>
              <span className="tl-badges">
                {group.overlapCount > 0 && <em className="tb-overlap">重叠 ×{group.overlapCount}</em>}
                {group.gapCount > 0 && <em className="tb-gap">间隔过短 ×{group.gapCount}</em>}
                {group.cancelledCount > 0 && <em className="tb-cancel">已取消 ×{group.cancelledCount}</em>}
                {!group.overlapCount && !group.gapCount && <em className={allCancelled ? 'tb-muted' : 'tb-ok'}>{allCancelled ? '全部已取消' : '无冲突'}</em>}
              </span>
            </div>
            <div className="tl-track" style={{ height: `${lanes.length * 38 + 10}px` }}>
              {model.days.map((day, idx) => { const [y, m, d] = day.key.split('-').map(Number); return <div key={day.key} className={`tl-daybg ${idx % 2 ? 'alt' : ''}`} style={{ left: `${model.pct(Math.max(new Date(y, m - 1, d).getTime(), model.rStart))}%`, width: `${model.pct(Math.min(new Date(y, m - 1, d + 1).getTime(), model.rEnd)) - model.pct(Math.max(new Date(y, m - 1, d).getTime(), model.rStart))}%` }} />; })}
              {model.days.slice(1).map(day => { const [y, m, d] = day.key.split('-').map(Number); const t = new Date(y, m - 1, d).getTime(); if (t <= model.rStart || t >= model.rEnd) return null; return <div key={day.key} className="tl-daysep" style={{ left: `${model.pct(t)}%` }} />; })}
              {group.items.flatMap(a => (model.zonesById.get(a.id) ?? []).map((z, i) => {
                if (z.start >= z.end || +new Date(a.windowStart) > Math.min(z.end, +new Date(a.windowEnd)) || +new Date(a.windowEnd) < Math.max(z.start, +new Date(a.windowStart))) return null;
                const left = model.pct(Math.max(z.start, model.rStart));
                const right = model.pct(Math.min(z.end, model.rEnd));
                return <div key={`${a.id}-z${i}`} className={`tl-zone ${z.kind}`} style={{ left: `${left}%`, width: `${Math.max(0.4, right - left)}%` }} />;
              }))}
              {group.items.map(a => {
                const lane = lanes.findIndex(row => row.includes(a));
                const left = model.pct(Math.max(+new Date(a.windowStart), model.rStart));
                const right = model.pct(Math.min(+new Date(a.windowEnd), model.rEnd));
                const width = Math.max(1.6, right - left);
                const crossDay = dayKey(+new Date(a.windowStart)) !== dayKey(+new Date(a.windowEnd));
                const marks = model.zonesById.get(a.id) ?? [];
                const meta = STATUS_META[a.status] ?? { label: a.status, glyph: '?' };
                return <button type="button" key={a.id} className={`tl-seg st-${a.status} ${marks.some(z => z.kind === 'overlap') ? 'mark-overlap' : ''} ${marks.some(z => z.kind === 'short-gap') ? 'mark-gap' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%`, top: `${lane * 38 + 5}px` }}
                  title={`${a.id}（${meta.label}）\n箱号：${a.containerId}\n窗口：${fullRange(a)}${crossDay ? '（跨天）' : ''}\n车道：${LANE_NAME[a.lane] ?? a.lane} · 司机：${a.driver}\n${a.exception ? `备注：${a.exception}\n` : ''}点击片段进入预约编辑`}
                  onClick={() => onEdit(a)}>
                  <span className="tl-seg-line"><i className="tl-glyph">{meta.glyph}</i><b>{a.id}</b>{crossDay && <em className="tl-cross">跨天</em>}</span>
                  <span className="tl-seg-time">{clock(a.windowStart)}–{clock(a.windowEnd)} · {a.containerId}</span>
                </button>;
              })}
            </div>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

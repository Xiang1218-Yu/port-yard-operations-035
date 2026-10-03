// 闸口预约时间线：按车牌聚合的派生数据与几何计算（纯函数，便于与服务端冲突引擎保持一致）

export type AppointmentStatus = 'booked' | 'checked-in' | 'completed' | 'cancelled' | 'exception';

export interface Appointment {
  id: string;
  containerId: string;
  truckNo: string;
  driver: string;
  type: 'pickup' | 'dropoff';
  windowStart: string;
  windowEnd: string;
  lane: 'north' | 'south' | 'rail';
  status: AppointmentStatus;
  exception?: string;
}

export interface GateConflict {
  severity: 'critical' | 'warning';
  kind: 'overlap' | 'short-gap' | 'customs';
  appointmentId: string;
  otherId?: string;
  reason: string;
}

export interface SegmentMarks {
  overlap: boolean;
  shortGap: boolean;
}

export interface TruckGroup {
  truckNo: string;
  drivers: string[];
  segments: Appointment[];
  marks: Map<string, SegmentMarks>;
  laneOf: Map<string, number>;
  lanes: number;
  hasOverlap: boolean;
  hasShortGap: boolean;
  firstStart: number;
}

export interface GapMarker {
  at: number;
  minutes: number;
  fromId: string;
  toId: string;
}

// 与服务端 MIN_TRUCK_TURNAROUND_MINUTES 保持一致：同车两次进场最小周转间隔
export const MIN_TURNAROUND_MS = 20 * 60000;

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export const statusLabels: Record<AppointmentStatus, string> = {
  booked: '已预约',
  'checked-in': '已签到',
  completed: '已完成',
  cancelled: '已取消',
  exception: '异常',
};

export const laneLabels: Record<Appointment['lane'], string> = {
  north: '北闸口',
  south: '南闸口',
  rail: '铁路闸口',
};

// 基于全量预约计算每个片段的重叠 / 间隔过短标记（已取消不占用时隙）
export function computeMarks(all: Appointment[]): Map<string, SegmentMarks> {
  const marks = new Map<string, SegmentMarks>();
  const active = all.filter(a => a.status !== 'cancelled');
  active.forEach(item => marks.set(item.id, { overlap: false, shortGap: false }));
  active.forEach((a, index) => {
    active.slice(index + 1).forEach(b => {
      if (a.truckNo !== b.truckNo) return;
      const aS = new Date(a.windowStart).getTime();
      const aE = new Date(a.windowEnd).getTime();
      const bS = new Date(b.windowStart).getTime();
      const bE = new Date(b.windowEnd).getTime();
      const ma = marks.get(a.id)!;
      const mb = marks.get(b.id)!;
      if (aS < bE && bS < aE) {
        ma.overlap = true;
        mb.overlap = true;
      } else {
        const gap = Math.max(aS, bS) - Math.min(aE, bE);
        if (gap >= 0 && gap < MIN_TURNAROUND_MS) {
          ma.shortGap = true;
          mb.shortGap = true;
        }
      }
    });
  });
  return marks;
}

// 区间图车道分配：时间上互不重叠（含取消片段避让，保证布局不错位）的片段共用同一车道
export function assignLanes(segments: Appointment[]): { laneOf: Map<string, number>; lanes: number } {
  const ordered = [...segments].sort((a, b) => +new Date(a.windowStart) - +new Date(b.windowStart));
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();
  ordered.forEach(segment => {
    const s = new Date(segment.windowStart).getTime();
    const e = new Date(segment.windowEnd).getTime();
    let lane = laneEnds.findIndex(end => s >= end);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(e);
    } else {
      laneEnds[lane] = e;
    }
    laneOf.set(segment.id, lane);
  });
  return { laneOf, lanes: Math.max(1, laneEnds.length) };
}

// 同一车牌相邻有效片段之间的间隔标记（用于在时间线上画出过短间隔）
export function gapMarkers(segments: Appointment[], marks: Map<string, SegmentMarks>): GapMarker[] {
  const active = segments
    .filter(s => s.status !== 'cancelled')
    .sort((a, b) => +new Date(a.windowStart) - +new Date(b.windowStart));
  const result: GapMarker[] = [];
  for (let i = 0; i < active.length - 1; i++) {
    const a = active[i];
    const b = active[i + 1];
    const aE = new Date(a.windowEnd).getTime();
    const bS = new Date(b.windowStart).getTime();
    const gap = bS - aE;
    if (gap >= 0 && gap < MIN_TURNAROUND_MS && (marks.get(a.id)?.shortGap || marks.get(b.id)?.shortGap)) {
      result.push({ at: (aE + bS) / 2, minutes: Math.round(gap / 60000), fromId: a.id, toId: b.id });
    }
  }
  return result;
}

export function groupByTruck(all: Appointment[], marks: Map<string, SegmentMarks>): TruckGroup[] {
  const map = new Map<string, Appointment[]>();
  all.forEach(item => {
    const list = map.get(item.truckNo) ?? [];
    list.push(item);
    map.set(item.truckNo, list);
  });
  const groups: TruckGroup[] = [];
  map.forEach((segments, truckNo) => {
    const sorted = [...segments].sort((a, b) => +new Date(a.windowStart) - +new Date(b.windowStart));
    const { laneOf, lanes } = assignLanes(sorted);
    const groupMarks = new Map<string, SegmentMarks>();
    sorted.forEach(s => groupMarks.set(s.id, marks.get(s.id) ?? { overlap: false, shortGap: false }));
    const drivers = [...new Set(sorted.map(s => s.driver))];
    groups.push({
      truckNo,
      drivers,
      segments: sorted,
      marks: groupMarks,
      laneOf,
      lanes,
      hasOverlap: sorted.some(s => groupMarks.get(s.id)?.overlap),
      hasShortGap: sorted.some(s => groupMarks.get(s.id)?.shortGap),
      firstStart: +new Date(sorted[0].windowStart),
    });
  });
  // 冲突车辆优先展示：重叠 > 间隔过短 > 车牌首约时间
  return groups.sort((a, b) =>
    Number(b.hasOverlap) - Number(a.hasOverlap)
    || Number(b.hasShortGap) - Number(a.hasShortGap)
    || a.firstStart - b.firstStart
    || a.truckNo.localeCompare(b.truckNo));
}

export interface TimeDomain { start: number; end: number }

export function buildDomain(visible: Appointment[], now: number): TimeDomain {
  if (!visible.length) {
    const step = HOUR_MS;
    return { start: Math.floor(now / step) * step, end: Math.ceil(now / step) * step + step };
  }
  const starts = visible.map(a => +new Date(a.windowStart));
  const ends = visible.map(a => +new Date(a.windowEnd));
  const start = Math.min(...starts, now) - 15 * 60000;
  const end = Math.max(...ends, now) + 15 * 60000;
  return { start, end };
}

export interface Tick { at: number; label: string; dayBoundary: boolean }

export function buildTicks(domain: TimeDomain): { ticks: Tick[]; dayBoundaries: number[] } {
  const spanHours = (domain.end - domain.start) / HOUR_MS;
  const stepHours = spanHours <= 6 ? 1 : spanHours <= 14 ? 2 : spanHours <= 30 ? 4 : spanHours <= 60 ? 8 : 12;
  const firstMidnight = new Date(domain.start);
  firstMidnight.setHours(0, 0, 0, 0);
  const ticks: Tick[] = [];
  for (let t = firstMidnight.getTime(); t <= domain.end; t += stepHours * HOUR_MS) {
    if (t < domain.start) continue;
    const d = new Date(t);
    const dayBoundary = d.getHours() === 0;
    ticks.push({ at: t, dayBoundary, label: dayBoundary ? dayLabel(t) : clockLabel(t) });
  }
  const dayBoundaries: number[] = [];
  for (let t = firstMidnight.getTime(); t <= domain.end; t += DAY_MS) {
    if (t > domain.start && t < domain.end) dayBoundaries.push(t);
  }
  return { ticks, dayBoundaries };
}

export const pct = (at: number, domain: TimeDomain) => ((at - domain.start) / (domain.end - domain.start)) * 100;

export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dayLabel(at: number): string {
  return `${String(new Date(at).getMonth() + 1).padStart(2, '0')}-${String(new Date(at).getDate()).padStart(2, '0')}`;
}

// 表格 / 片段共用的窗口文本：跨天窗口显式带上日期
export function formatWindow(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const sameDay = s.toDateString() === e.toDateString();
  if (sameDay) return `${dayLabel(+s)} ${clockLabel(+s)}–${clockLabel(+e)}`;
  return `${dayLabel(+s)} ${clockLabel(+s)} → ${dayLabel(+e)} ${clockLabel(+e)}`;
}

export function segmentTitle(a: Appointment, marks: SegmentMarks | undefined, reasons: string[]): string {
  const lines = [
    `${a.id} · ${statusLabels[a.status]}`,
    `箱号 ${a.containerId} · ${a.type === 'pickup' ? '提箱' : '进场'}`,
    `车辆 ${a.truckNo} · 司机 ${a.driver}`,
    `窗口 ${formatWindow(a.windowStart, a.windowEnd)}`,
    laneLabels[a.lane],
  ];
  if (marks?.overlap) lines.push('⚠ 与同车其它预约时间重叠');
  if (marks?.shortGap) lines.push('⚠ 与相邻预约间隔短于 20 分钟');
  if (a.exception) lines.push(`备注：${a.exception}`);
  reasons.forEach(reason => lines.push(`冲突：${reason}`));
  return lines.join('\n');
}

import { useMemo } from 'react';
import {
  Appointment, GateConflict, TimeDomain, TruckGroup,
  buildTicks, clockLabel, dayLabel, formatWindow, gapMarkers, laneLabels,
  pct, segmentTitle,
} from './timeline';

interface Props {
  groups: TruckGroup[];
  domain: TimeDomain;
  now: number;
  conflicts: GateConflict[];
  onEdit: (appointment: Appointment) => void;
}

const DAY_LINE = 'rgba(113,190,214,0.45)';
const TICK_LINE = 'rgba(120,160,175,0.14)';

function Lines({ domain, ticks, dayBoundaries, now, showNowLabel }: { domain: TimeDomain; ticks: ReturnType<typeof buildTicks>['ticks']; dayBoundaries: number[]; now: number; showNowLabel?: boolean }) {
  return <>
    {ticks.map(tick => (
      <i key={`tick-${tick.at}`} className="tl-tick-line" style={{ left: `${pct(tick.at, domain)}%`, background: tick.dayBoundary ? DAY_LINE : TICK_LINE }} />
    ))}
    {dayBoundaries.map(at => (
      <i key={`day-${at}`} className="tl-day-line" style={{ left: `${pct(at, domain)}%` }} />
    ))}
    {now >= domain.start && now <= domain.end && (
      <i className={`tl-now-line${showNowLabel ? '' : ' no-label'}`} style={{ left: `${pct(now, domain)}%` }} />
    )}
  </>;
}

export default function GateTimeline({ groups, domain, now, conflicts, onEdit }: Props) {
  const { ticks, dayBoundaries } = useMemo(() => buildTicks(domain), [domain]);
  const reasonsById = useMemo(() => {
    const map = new Map<string, string[]>();
    conflicts.forEach(c => {
      const list = map.get(c.appointmentId) ?? [];
      list.push(c.reason);
      map.set(c.appointmentId, list);
    });
    return map;
  }, [conflicts]);

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="lg-booked" />已预约</span>
        <span><i className="lg-checked" />已签到</span>
        <span><i className="lg-cancelled" />已取消</span>
        <span><i className="lg-overlap" />时间重叠</span>
        <span><i className="lg-shortgap" />间隔过短 (&lt;20 分钟)</span>
        <span><i className="lg-now" />当前时刻</span>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner">
          <div className="tl-grid tl-axis">
            <div className="tl-rowhead tl-corner">车牌 / 司机</div>
            <div className="tl-track">
              <Lines domain={domain} ticks={ticks} dayBoundaries={dayBoundaries} now={now} showNowLabel/>
              {ticks.map(tick => (
                <span key={`label-${tick.at}`} className={`tl-tick-label${tick.dayBoundary ? ' day' : ''}`} style={{ left: `${pct(tick.at, domain)}%` }}>
                  {tick.dayBoundary && <b>{dayLabel(tick.at)}</b>}{clockLabel(tick.at)}
                </span>
              ))}
            </div>
          </div>
          {groups.map(group => {
            const markers = gapMarkers(group.segments, group.marks);
            return (
              <div className="tl-grid tl-row" key={group.truckNo}>
                <div className="tl-rowhead">
                  <b>{group.truckNo}</b>
                  <small>{group.drivers.join(' / ')}</small>
                  <span className="tl-badges">
                    <em className="tl-count">{group.segments.length} 个窗口</em>
                    {group.hasOverlap
                      ? <em className="tl-badge critical">重叠</em>
                      : group.hasShortGap
                        ? <em className="tl-badge warning">间隔过短</em>
                        : <em className="tl-badge ok">时序正常</em>}
                  </span>
                </div>
                <div className="tl-track" style={{ height: group.lanes * 36 + 22 }}>
                  <Lines domain={domain} ticks={ticks} dayBoundaries={dayBoundaries} now={now} />
                  {group.segments.map(segment => {
                    const s = new Date(segment.windowStart).getTime();
                    const e = new Date(segment.windowEnd).getTime();
                    const marks = group.marks.get(segment.id);
                    const lane = group.laneOf.get(segment.id) ?? 0;
                    const width = Math.max(pct(e, domain) - pct(s, domain), 0.6);
                    const crossDay = new Date(segment.windowStart).toDateString() !== new Date(segment.windowEnd).toDateString();
                    return (
                      <button
                        type="button"
                        key={segment.id}
                        className={`tl-seg ${segment.status}${marks?.overlap ? ' overlap' : ''}${marks?.shortGap ? ' shortgap' : ''}`}
                        style={{ left: `${pct(s, domain)}%`, width: `${width}%`, top: 11 + lane * 36 }}
                        title={segmentTitle(segment, marks, reasonsById.get(segment.id) ?? [])}
                        onClick={() => onEdit(segment)}
                      >
                        <span className="tl-seg-id">{segment.containerId.slice(-5)}</span>
                        <span className="tl-seg-time">{clockLabel(s)}–{clockLabel(e)}{crossDay && <i className="tl-crossday" title={formatWindow(segment.windowStart, segment.windowEnd)}>跨天</i>}</span>
                        <span className="tl-seg-lane">{laneLabels[segment.lane]}</span>
                      </button>
                    );
                  })}
                  {markers.map(marker => (
                    <span
                      key={`${marker.fromId}-${marker.toId}`}
                      className="tl-gap"
                      style={{ left: `${pct(marker.at, domain)}%`, top: (group.lanes * 36 + 22) / 2 - 8 }}
                      title={`相邻预约仅间隔 ${marker.minutes} 分钟（建议至少 20 分钟周转）`}
                    >{marker.minutes}′</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="timeline-hint">点击任意时间片段可直接进入预约编辑；保存后时间线、明细与冲突提示同步刷新。</div>
    </div>
  );
}

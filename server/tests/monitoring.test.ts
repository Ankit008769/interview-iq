import {expect,it,vi} from 'vitest';
import {operationalEvent} from '../src/services/monitoring.js';
// @ts-ignore Configuration is intentionally shared with the standalone deployment CLI.
import {metrics,policies,uptime,dashboard} from '../../deploy/monitoring-config.mjs';
it('emits bounded operational events without exception or candidate payloads',()=>{
 const spy=vi.spyOn(console,'log').mockImplementation(()=>{});
 operationalEvent('worker_heartbeat','INFO');expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({event:'worker_heartbeat',severity:'INFO',component:'interviewiq'});
 expect(Object.keys(JSON.parse(spy.mock.calls[0][0])).sort()).toEqual(['component','event','severity','timestamp']);spy.mockRestore();
});
it('scopes backup events to the data disk and requires completed successful operations',()=>{
 expect(metrics[0].filter).toContain('1864710073775211764');expect(metrics[0].filter).toContain('operation.last=true');expect(metrics[0].filter).toContain('NOT protoPayload.response.error:*');
 expect(metrics[1].filter).toContain('severity>INFO');
});
it('alerts on stale backups and aggregates worker revisions to prevent retirement false alarms',()=>{
 const list=policies('projects/test/notificationChannels/owner','health-test');expect(list).toHaveLength(6);
 expect(list.every((p:any)=>p.notificationChannels[0]==='projects/test/notificationChannels/owner')).toBe(true);
 expect(list[2].conditions[0].conditionAbsent.duration).toBe('10800s');
 expect(list[3].conditions[0].conditionAbsent.aggregations[0].crossSeriesReducer).toBe('REDUCE_SUM');
 expect(list[0].conditions[0].conditionThreshold.thresholdValue).toBe(1);
 expect(uptime.httpCheck.validateSsl).toBe(true);expect(uptime.contentMatchers[0].content).toContain('connected');expect(dashboard().gridLayout.widgets).toHaveLength(6);
});

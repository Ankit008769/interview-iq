import { afterEach, expect, it, vi } from 'vitest';
import { readRateCard, estimateCost, reconcileUsage, type Rate } from '../src/services/usageCost.js';
import { newRun, measureRun, compareRuns } from '../src/calibration/comparison.js';
import { parseItems } from '../src/calibration/dataset.js';
const rate: Rate = {version:'fixture-v1',provider:'openai',endpoint:'https://api.openai.com/v1',model:'fixture-model',slot:'judge',
  source:'https://example.test/rates',validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',inputUsdPerMillion:2,outputUsdPerMillion:8,cachedInputUsdPerMillion:1};
const usage={provider:rate.provider,endpoint:rate.endpoint,model:rate.model,slot:rate.slot,inputTokens:1000,outputTokens:100,at:new Date('2026-10-25')};
afterEach(()=>vi.unstubAllEnvs());
it('prices exact model/endpoint/slot with retained rate provenance and cached-token discount',()=>{
  expect(estimateCost([rate],usage)).toEqual({amountUsd:0.0028,reason:'estimated',rate});
  expect(estimateCost([rate],{...usage,cachedInputTokens:500}).amountUsd).toBe(0.0023);
  for(const override of [{model:'alias'},{endpoint:'https://other.test/v1'},{slot:'interviewer'},{at:new Date('2027-01-01')}]) expect(estimateCost([rate],{...usage,...override}).amountUsd).toBeNull();
});
it('keeps missing, invalid, audio and interrupted usage unknown; only cancelled dispatch is zero',()=>{
  for(const override of [{inputTokens:null},{outputTokens:-1},{inputTokens:1.5},{cachedInputTokens:1001},{slot:'transcriber'}]) expect(estimateCost([rate],{...usage,...override}).amountUsd).toBeNull();
  const {cachedInputUsdPerMillion,...uncached}=rate;
  expect(estimateCost([uncached],{...usage,cachedInputTokens:1}).reason).toBe('missing_cached_rate');
  expect(estimateCost([],{...usage,inputTokens:null,cancelled:true})).toEqual({amountUsd:0,reason:'cancelled_before_dispatch'});
});
it('rejects overlapping or malformed cards and allows distinct time windows',()=>{
  vi.stubEnv('AI_RATE_CARD_JSON',JSON.stringify([rate,rate]));expect(()=>readRateCard()).toThrow('Invalid');
  vi.stubEnv('AI_RATE_CARD_JSON',JSON.stringify([{...rate,inputUsdPerMillion:-1}]));expect(()=>readRateCard()).toThrow();
  vi.stubEnv('AI_RATE_CARD_JSON',JSON.stringify([rate,{...rate,version:'v2',validFrom:rate.validUntil,validUntil:'2028-01-01T00:00:00.000Z'}]));expect(readRateCard()).toHaveLength(2);
  vi.stubEnv('AI_RATE_CARD_JSON','');expect(readRateCard()).toEqual([]);
});
const items=parseItems(JSON.stringify({id:'one',type:'Technical',role:'Developer',difficulty:'Beginner',topic:'Arrays',question:'What is indexed access?',answer:'An array supports direct indexed access.',source:'synthetic'}));
const metadata={label:'a',provider:'openai',endpoint:rate.endpoint,requestedModel:rate.model,reviewed:true};
const feedback:any={answers:[{criteria:[{score:3,evidence:{quote:'array'}}]}],generation:{model:rate.model,promptVersion:'prompt.v1',inputTokens:1000,outputTokens:100,cost:{amountUsd:0.0028,reason:'estimated',rate}}};
it('compares the same reviewed dataset, retains failures and refuses to invent a quality winner',async()=>{
  const checkpoints:any[]=[];
  const a=await measureRun(items,newRun(items,metadata),async()=>feedback,r=>checkpoints.push(structuredClone(r)));
  const b=await measureRun(items,newRun(items,{...metadata,label:'b'}),async()=>{throw new Error('private provider payload');});
  const report=compareRuns([a,b]);
  expect(report.runs[0]).toMatchObject({attempts:1,failures:0,estimatedCostUsd:0.0028,unknownCostAttempts:0,supportedCriteria:1});
  expect(report.runs[1]).toMatchObject({attempts:1,failures:1,estimatedCostUsd:0,unknownCostAttempts:1});
  expect(report.qualityVerdict).toContain('No automatic winner');expect(JSON.stringify(b)).not.toContain('private');expect(checkpoints).toHaveLength(1);
});
it('rejects incomplete, duplicate, different-dataset and different-prompt runs',async()=>{
  const a=await measureRun(items,newRun(items,metadata),async()=>feedback);
  const b=structuredClone(a);b.label='b';
  expect(()=>compareRuns([a,{...b,rows:[]}])).toThrow('Incomplete');
  expect(()=>compareRuns([a,a])).toThrow('unique');
  expect(()=>compareRuns([a,{...b,datasetHash:'a'.repeat(64)}])).toThrow('mismatch');
  b.rows[0].promptVersion='different';expect(()=>compareRuns([a,b])).toThrow('Prompt');
});

it('reconciles only the declared half-open billing scope and refuses duplicate or missing receipts',()=>{
  const scope={provider:'openai',model:'fixture-model',from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z',billedUsd:0.01};
  const entry={_id:'one',provider:scope.provider,model:scope.model,createdAt:'2026-10-25T00:00:00.000Z',cost:{amountUsd:0.0028}};
  const outside={...entry,_id:'outside',createdAt:'2026-11-01T00:00:00.000Z'};
  expect(reconcileUsage([entry,outside],scope)).toMatchObject({attempts:1,estimatedCostUsd:0.0028,differenceUsd:0.0072,unknownCostAttempts:0});
  expect(reconcileUsage([{...entry,cost:{amountUsd:null}}],scope).differenceUsd).toBeNull();
  expect(()=>reconcileUsage([entry,entry],scope)).toThrow('Duplicate');
  expect(()=>reconcileUsage([outside],scope)).toThrow('No usage');
});

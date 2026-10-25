import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseItems } from '../calibration/dataset.js';
import { newRun, measureRun, compareRuns, calibrationRatings } from '../calibration/comparison.js';
import { aiDisclosure } from '../services/providerConsent.js';
import { providerConfig } from '../services/providerConfig.js';
import { readRateCard, reconcileUsage } from '../services/usageCost.js';
const [command, ...rest] = process.argv.slice(2);
const args = new Map<string,string>();
for (let i=0;i<rest.length;i++) { if (!rest[i].startsWith('--')) throw new Error('Expected named arguments');
  const key=rest[i].slice(2);args.set(key,rest[i+1]&&!rest[i+1].startsWith('--')?rest[++i]:'true'); }
const need=(key:string)=>{const value=args.get(key);if(!value||value==='true')throw new Error(`Missing --${key}`);return value;};
async function main() {
  const out=need('out'); if(existsSync(out)||existsSync(out+'.tmp'))throw new Error('Output already exists; choose a new path.');
  if(command==='export-calibration') {
    const items=parseItems(readFileSync(need('items'),'utf8'));
    const ratings=calibrationRatings(JSON.parse(readFileSync(need('run'),'utf8')),items);
    writeFileSync(out,ratings.map(r=>JSON.stringify(r)).join('\n')+'\n',{flag:'wx'});
    console.log('Calibration scorecards exported without additional provider calls.');return;
  }
  if(command==='reconcile') {
    if(args.get('scope-matched')!=='true')throw new Error('Explicit matching billing scope is required.');
    const data=JSON.parse(readFileSync(need('usage'),'utf8'));
    const result=reconcileUsage(Array.isArray(data)?data:data.usage,{provider:need('provider'),model:need('model'),from:need('from'),to:need('to'),billedUsd:Number(need('billed-usd'))});
    writeFileSync(out,JSON.stringify(result,null,2),{flag:'wx'});console.log('Scoped cost reconciliation written.');return;
  }
  if(command==='report') {
    const report=compareRuns(need('runs').split(',').map(path=>JSON.parse(readFileSync(path,'utf8'))));
    writeFileSync(out,JSON.stringify(report,null,2),{flag:'wx'}); console.log('Comparison report written; human quality verdict remains open.');return;
  }
  if(command!=='run')throw new Error('Use run or report. See docs/USAGE_COST_AND_COMPARISON.md');
  if(process.env.NODE_ENV==='production')throw new Error('Do not run benchmarks in the production app environment.');
  const items=parseItems(readFileSync(need('items'),'utf8'));
  const max=Number(args.get('max-items')||25);
  if(!Number.isSafeInteger(max)||max<1||max>1000||items.length>max)throw new Error('Dataset exceeds explicit --max-items (default 25, maximum 1000).');
  const disclosure=aiDisclosure(),config=providerConfig();readRateCard();
  if(!disclosure)throw new Error('Configure an AI provider explicitly.');
  const run=newRun(items,{label:need('label'),provider:config.provider,endpoint:config.baseURL!,requestedModel:disclosure.judgeModel,reviewed:args.get('reviewed')==='true'});
  if(args.get('yes')!=='true'||!run.reviewed){console.log(`Dry run: ${items.length} sequential evaluator calls to ${disclosure.provider} (${disclosure.endpoint}), model ${disclosure.judgeModel}. Paid usage may apply. Inspect the dataset and re-run with --reviewed --yes. No calls made.`);return;}
  const write=()=>{writeFileSync(out+'.tmp',JSON.stringify(run,null,2),{flag:'wx'});renameSync(out+'.tmp',out);};
  writeFileSync(out,JSON.stringify(run,null,2),{flag:'wx'});await measureRun(items,run,undefined,write);console.log(`Finished ${run.rows.length} attempts. Failed attempts remain in the report with unknown cost.`);
}
main().catch(()=>{console.error('Comparison failed. Check arguments, configuration and input files. Existing partial results are retained; provider payloads are not logged.');process.exitCode=1;});

import { beforeAll, beforeEach, afterAll, afterEach, it, expect, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { User } from '../src/models/User.js';
import { Interview } from '../src/models/Interview.js';
import { AccountToken, AuthSession, AccountDeletion } from '../src/models/Account.js';
import { AIUsage } from '../src/models/AIUsage.js';
import { QuotaBucket } from '../src/services/quotas.js';
import { issueAccountToken, processAccountDeletions, tokenHash } from '../src/services/account.js';
import * as mail from '../src/services/accountMail.js';
import { configuredProvider } from '../src/services/modelProvider.js';
import { z } from 'zod';
process.env.JWT_SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
const { app } = await import('../src/app.js');
let mongo: MongoMemoryServer;
const password = 'account-test-password';
let sequence = 0;
const setup = {role:'Developer',type:'Technical',difficulty:'Beginner',topic:'React',totalQuestions:2};
beforeAll(async()=>{ mongo=await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all([AuthSession.init(),AccountToken.init(),AccountDeletion.init()]); },120_000);
beforeEach(async()=>{vi.stubEnv('AI_PROVIDER','practice'); await Promise.all(Object.values(mongoose.connection.collections).map(c=>c.deleteMany({})));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();});
async function register() {
  const agent=request.agent(app), email=`account-${++sequence}@example.test`;
  const response=await agent.post('/api/auth/register').send({name:'Account Tester',email,password}).expect(201);
  return {agent,email,id:response.body.user.id as string, cookie:(response.headers['set-cookie'] as unknown as string[])[0].split(';')[0]};
}
it('stores only hashed session secrets, enforces expiry and revokes only owned sessions',async()=>{
  const a=await register(), b=await register();
  const raw=a.cookie.split('=')[1]; const stored=await AuthSession.findOne({userId:a.id}).select('+tokenHash');
  expect(stored!.tokenHash).toBe(tokenHash(raw)); expect(stored!.tokenHash).not.toBe(raw);
  await a.agent.delete(`/api/account/sessions/${(await AuthSession.findOne({userId:b.id}))!.id}`).expect(404);
  await AuthSession.updateOne({_id:stored!._id},{$set:{expiresAt:new Date(0)}});
  await a.agent.get('/api/auth/me').expect(401); await b.agent.get('/api/auth/me').expect(200);
});
it('revoke-all invalidates copied cookies and a version-stale session created after revocation',async()=>{
  const a=await register();await a.agent.post('/api/account/revoke-all').expect(200);
  await request(app).get('/api/auth/me').set('Cookie',a.cookie).expect(401);
  await AuthSession.create({userId:a.id,tokenHash:tokenHash(a.cookie.split('=')[1]),version:0,expiresAt:new Date(Date.now()+100000)});
  await request(app).get('/api/auth/me').set('Cookie',a.cookie).expect(401);
});
it('keeps mail disabled without exposing or generating recovery secrets',async()=>{
  const a=await register();await a.agent.post('/api/auth/forgot-password').send({email:a.email}).expect(503);
  await a.agent.post('/api/auth/verification-email').expect(503);
  expect(await AccountToken.countDocuments()).toBe(0);
  expect((await a.agent.get('/api/auth/capabilities')).body.emailDelivery).toBe(false);
});
it('delivers reset links only to a mocked mailbox, consumes once and revokes every session',async()=>{
  const a=await register(); const mailbox:string[]=[];
  vi.spyOn(mail,'emailDeliveryAvailable').mockReturnValue(true);
  vi.spyOn(mail,'sendAccountLink').mockImplementation(async(_email,_purpose,url)=>{mailbox.push(url);});
  const response=await request(app).post('/api/auth/forgot-password').send({email:a.email}).expect(200);
  const unknown=await request(app).post('/api/auth/forgot-password').send({email:'absent@example.test'}).expect(200);
  expect(response.body).toEqual(unknown.body);expect(mailbox).toHaveLength(1);
  const token=new URL(mailbox[0]).hash.split('=')[1];expect(JSON.stringify(response.body)).not.toContain(token);
  const results=await Promise.all([1,2].map(()=>request(app).post('/api/auth/reset-password').send({token,password:'replacement-password'})));
  expect(results.map(r=>r.status).sort()).toEqual([200,400]);
  await request(app).get('/api/auth/me').set('Cookie',a.cookie).expect(401);
  await request(app).post('/api/auth/login').send({email:a.email,password}).expect(401);
  await request(app).post('/api/auth/login').send({email:a.email,password:'replacement-password'}).expect(200);
});
it('rejects expired, wrong-purpose and version-stale action links; verifies email once',async()=>{
  const a=await register();const user=(await User.findById(a.id))!;
  const expired=await issueAccountToken(user,'reset');await AccountToken.updateMany({},{$set:{expiresAt:new Date(0)}});
  await request(app).post('/api/auth/reset-password').send({token:expired,password}).expect(400);
  const verify=await issueAccountToken(user,'verify');await request(app).post('/api/auth/reset-password').send({token:verify,password}).expect(400);
  await request(app).post('/api/auth/verify-email').send({token:verify}).expect(200);
  await request(app).post('/api/auth/verify-email').send({token:verify}).expect(400);
  expect((await a.agent.get('/api/auth/me')).body.user.emailVerified).toBe(true);
  const stale=await issueAccountToken(user,'reset');await User.updateOne({_id:a.id},{$inc:{authVersion:1}});
  await request(app).post('/api/auth/reset-password').send({token:stale,password}).expect(400);
});
it('supports legacy accounts without authVersion and rejects bcrypt truncation for new passwords',async()=>{
  const a=await register();await User.collection.updateOne({_id:new mongoose.Types.ObjectId(a.id)},{$unset:{authVersion:''}});
  await a.agent.post('/api/account/password').send({currentPassword:password,newPassword:'😀'.repeat(20)}).expect(400);
  await a.agent.post('/api/account/password').send({currentPassword:'incorrect',newPassword:'replacement-password'}).expect(400);
  await a.agent.post('/api/account/password').send({currentPassword:password,newPassword:'replacement-password'}).expect(200);
  await request(app).get('/api/auth/me').set('Cookie',a.cookie).expect(401);
  await request(app).post('/api/auth/login').send({email:a.email,password:'replacement-password'}).expect(200);
});
it('exports only owned data and reports unknown usage separately',async()=>{
  const a=await register(), b=await register();await a.agent.post('/api/interviews').send(setup).expect(201);await b.agent.post('/api/interviews').send(setup).expect(201);
  await AIUsage.create([{userId:a.id,status:'failed',inputTokens:12,outputTokens:4},{userId:a.id},{userId:b.id,inputTokens:9000,outputTokens:9000}]);
  const exported=await a.agent.get('/api/account/export').expect(200);
  expect(exported.body.interviews).toHaveLength(1);expect(exported.body.usage).toHaveLength(2);
  expect(exported.body.user.id).toBe(a.id);expect(JSON.stringify(exported.body)).not.toContain('passwordHash');expect(JSON.stringify(exported.body)).not.toContain(b.id);
  const usage=(await a.agent.get('/api/account/usage').expect(200)).body;
  expect(usage.rows.find((r:any)=>r._id==='started').unknownUsage).toBe(1);expect(usage.rows.find((r:any)=>r._id==='failed').inputTokens).toBe(12);
});
it('deletion revokes access immediately, retries cleanup and removes late writes using receipts',async()=>{
  const a=await register(), b=await register();await a.agent.post('/api/interviews').send(setup).expect(201);
  await AIUsage.create({userId:a.id});await issueAccountToken((await User.findById(a.id))!,'reset');
  await a.agent.post('/api/account/delete').send({password,confirmation:'wrong'}).expect(400);
  await a.agent.post('/api/account/delete').send({password,confirmation:'DELETE'}).expect(202);
  await request(app).get('/api/auth/me').set('Cookie',a.cookie).expect(401);
  await request(app).post('/api/auth/login').send({email:a.email,password}).expect(401);
  await processAccountDeletions();expect(await User.findById(a.id)).not.toBeNull();
  vi.spyOn(AIUsage,'deleteMany').mockRejectedValueOnce(new Error('temporary DB failure'));
  await expect(processAccountDeletions(new Date(Date.now()+61000))).rejects.toThrow('temporary DB failure');
  expect(await User.findById(a.id)).not.toBeNull();
  await processAccountDeletions(new Date(Date.now()+61000));expect(await User.findById(a.id)).toBeNull();
  for(const model of [Interview,AIUsage,AuthSession,AccountToken] as any[]) expect(await model.countDocuments({userId:a.id})).toBe(0);
  expect(await QuotaBucket.countDocuments({_id:{$regex:`^${a.id}:`}})).toBe(0);
  expect(await AccountDeletion.countDocuments({userId:a.id})).toBe(1);
  await AIUsage.create({userId:a.id});await processAccountDeletions(new Date(Date.now()+122000));expect(await AIUsage.countDocuments({userId:a.id})).toBe(0);
  await b.agent.get('/api/auth/me').expect(200);
});
it('shares authentication limits in Mongo and supplies retry time',async()=>{
  for(let i=0;i<20;i++) await request(app).post('/api/auth/login').send({email:'none@example.test',password}).expect(401);
  const limited=await request(app).post('/api/auth/login').send({email:'none@example.test',password}).expect(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
});
it('records rejected output tokens and unknown transport failures without recording candidate text',async()=>{
  const a=await register();vi.stubEnv('AI_PROVIDER','openai');vi.stubEnv('OPENAI_API_KEY','test-not-real');
  const call={usageContext:{userId:a.id},slot:'judge' as const,system:'secret candidate prompt',input:'secret answer',schema:z.object({ok:z.boolean()}),name:'test',promptVersion:'v1',maxOutputTokens:100};
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({id:'r',model:'resolved',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'not json'}]}],usage:{input_tokens:13,output_tokens:7}}),{headers:{'content-type':'application/json'}}));
  await expect(configuredProvider()!.structured(call)).rejects.toThrow('valid response');
  const invalid=await AIUsage.findOne({userId:a.id}).lean();expect(invalid).toMatchObject({status:'failed',failure:'invalid_output',inputTokens:13,outputTokens:7});
  fetch.mockRejectedValue(new Error('private upstream payload'));
  await expect(configuredProvider()!.structured(call)).rejects.toThrow('valid response');
  const failed=await AIUsage.findOne({failure:'provider_error'}).lean();expect(failed).toMatchObject({status:'failed',inputTokens:null,outputTokens:null});
  expect(JSON.stringify(await AIUsage.find({}))).not.toContain('secret answer');expect(fetch).toHaveBeenCalledTimes(2);
});

import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, AccountLoadError } from './components/AuthProvider';
import { Layout, LoadingScreen } from './components/Layout';
import { AuthPage } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { Setup } from './pages/Setup';
import { InterviewRoom } from './pages/Interview';
import { Results } from './pages/Results';
import { History } from './pages/History';
import { Account, AccountRecovery } from './pages/Account';
import { Documents } from './pages/Documents';
import { Learn } from './pages/Learn';
import { CodingList } from './pages/Coding';
import { ProjectPage } from './pages/Project';
import { DesignList } from './pages/Design';
import { Campus } from './pages/Campus';
import { CohortPage, OrgPage } from './pages/OrgAdmin';
const DesignWorkspace = lazy(() => import('./pages/DesignWorkspace').then(m => ({ default: m.DesignWorkspace })));
// The editor is large, so the problem workspace loads on demand.
const CodingProblemPage = lazy(() => import('./pages/CodingProblem').then(m => ({ default: m.CodingProblemPage })));
import './style.css';
function Protected(){const{user,loading,error}=useAuth();const location=useLocation();if(loading)return <LoadingScreen/>;if(error)return <AccountLoadError/>;return user?<Layout/>:<Navigate to="/login" state={{from:location.pathname}} replace/>}
function PublicAuth({register=false}:{register?:boolean}){const{user,loading,error}=useAuth();if(loading)return <LoadingScreen/>;if(error)return <AccountLoadError/>;return user?<Navigate to="/dashboard" replace/>:<AuthPage register={register}/>}
function App(){return <AuthProvider><BrowserRouter><Routes>
  <Route path="/account/recovery" element={<AccountRecovery/>}/><Route path="/account/verify" element={<AccountRecovery verify/>}/>
  <Route path="/login" element={<PublicAuth/>}/><Route path="/register" element={<PublicAuth register/>}/>
  <Route element={<Protected/>}><Route path="/account" element={<Account/>}/><Route path="/dashboard" element={<Dashboard/>}/><Route path="/interview/new" element={<Setup/>}/><Route path="/interview/:id" element={<InterviewRoom/>}/><Route path="/interview/:id/results" element={<Results/>}/><Route path="/history" element={<History/>}/><Route path="/documents" element={<Documents/>}/><Route path="/learn" element={<Learn/>}/><Route path="/coding" element={<CodingList/>}/><Route path="/projects/:id" element={<ProjectPage/>}/><Route path="/design" element={<DesignList/>}/><Route path="/campus" element={<Campus/>}/><Route path="/org/:orgId" element={<OrgPage/>}/><Route path="/org/:orgId/cohorts/:cohortId" element={<CohortPage/>}/><Route path="/design/:id" element={<Suspense fallback={<LoadingScreen/>}><DesignWorkspace/></Suspense>}/><Route path="/coding/:id" element={<Suspense fallback={<LoadingScreen/>}><CodingProblemPage/></Suspense>}/></Route>
  <Route path="*" element={<Navigate to="/dashboard" replace/>}/>
</Routes></BrowserRouter></AuthProvider>}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

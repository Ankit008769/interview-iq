import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './components/AuthProvider';
import { Layout, LoadingScreen } from './components/Layout';
import { AuthPage } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { Setup } from './pages/Setup';
import { InterviewRoom } from './pages/Interview';
import { Results } from './pages/Results';
import { History } from './pages/History';
import './style.css';
function Protected(){const{user,loading}=useAuth();const location=useLocation();if(loading)return <LoadingScreen/>;return user?<Layout/>:<Navigate to="/login" state={{from:location.pathname}} replace/>}
function PublicAuth({register=false}:{register?:boolean}){const{user,loading}=useAuth();if(loading)return <LoadingScreen/>;return user?<Navigate to="/dashboard" replace/>:<AuthPage register={register}/>}
function App(){return <AuthProvider><BrowserRouter><Routes>
  <Route path="/login" element={<PublicAuth/>}/><Route path="/register" element={<PublicAuth register/>}/>
  <Route element={<Protected/>}><Route path="/dashboard" element={<Dashboard/>}/><Route path="/interview/new" element={<Setup/>}/><Route path="/interview/:id" element={<InterviewRoom/>}/><Route path="/interview/:id/results" element={<Results/>}/><Route path="/history" element={<History/>}/></Route>
  <Route path="*" element={<Navigate to="/dashboard" replace/>}/>
</Routes></BrowserRouter></AuthProvider>}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { Spinner } from '@/components/ui';
import { useBootstrap } from '@/lib/queries';

const Chat = lazy(() => import('@/pages/Chat'));
const Settings = lazy(() => import('@/pages/Settings'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Agents = lazy(() => import('@/pages/Agents'));
const AgentBuilder = lazy(() => import('@/pages/AgentBuilder'));
const Runs = lazy(() => import('@/pages/Runs'));
const RunDetail = lazy(() => import('@/pages/RunDetail'));
const NewRun = lazy(() => import('@/pages/NewRun'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Mcp = lazy(() => import('@/pages/Mcp'));
const Audit = lazy(() => import('@/pages/Audit'));
const ApiDocs = lazy(() => import('@/pages/ApiDocs'));

const Loading = () => <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;

export default function App() {
  const { data: boot, isLoading, error } = useBootstrap();
  if (isLoading) return <Loading />;
  if (error || !boot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <h1 className="text-lg font-semibold">Can't reach the Minions server</h1>
        <p className="max-w-md text-sm text-muted">{(error as Error | null)?.message ?? 'Unknown error'}. If an access token is required, set it in this browser session and reload.</p>
      </div>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        {!boot.onboardingCompleted && <Route path="*" element={<Onboarding />} />}
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<Chat />} />
          <Route path="chat/:threadId" element={<Chat />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/new" element={<AgentBuilder />} />
          <Route path="agents/:id/edit" element={<AgentBuilder />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/new" element={<NewRun />} />
          <Route path="runs/:id" element={<RunDetail />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="mcp" element={<Mcp />} />
          <Route path="audit" element={<Audit />} />
          <Route path="docs" element={<ApiDocs />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

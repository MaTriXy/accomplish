import { createHashRouter, Navigate } from 'react-router';
import { RouteErrorFallback } from './components/ui/RouteErrorFallback';
import { App } from './App';
import { HomePage } from './pages/Home';
import ExecutionPage from './pages/Execution';
import RecordingDetailPage from './pages/RecordingDetail';
import RecordingsPage from './pages/Recordings';

export const router = createHashRouter([
  {
    path: '/',
    Component: App,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true, Component: HomePage, errorElement: <RouteErrorFallback /> },
      { path: 'execution/:id', Component: ExecutionPage, errorElement: <RouteErrorFallback /> },
      { path: 'recordings', Component: RecordingsPage, errorElement: <RouteErrorFallback /> },
      {
        path: 'recordings/:recordingId',
        Component: RecordingDetailPage,
        errorElement: <RouteErrorFallback />,
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

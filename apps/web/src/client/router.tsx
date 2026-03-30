import { createHashRouter, Navigate } from 'react-router';
import { App } from './App';
import { HomePage } from './pages/Home';
import ExecutionPage from './pages/Execution';
import RecordingDetailPage from './pages/RecordingDetail';
import RecordingsPage from './pages/Recordings';

export const router = createHashRouter([
  {
    path: '/',
    Component: App,
    children: [
      { index: true, Component: HomePage },
      { path: 'execution/:id', Component: ExecutionPage },
      { path: 'recordings', Component: RecordingsPage },
      { path: 'recordings/:recordingId', Component: RecordingDetailPage },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

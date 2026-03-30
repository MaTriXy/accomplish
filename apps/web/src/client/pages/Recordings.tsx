import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ArrowLeft, DownloadSimple, Trash, UploadSimple } from '@phosphor-icons/react';
import { useRecordingStore } from '../stores/recordingStore';

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function RecordingsPage() {
  const navigate = useNavigate();
  const [manualRecordingName, setManualRecordingName] = useState('');
  const [manualRecordingUrl, setManualRecordingUrl] = useState('');
  const {
    recordings,
    isLoading,
    error,
    loadRecordings,
    deleteRecording,
    exportRecording,
    importRecording,
    startManualRecording,
    stopManualRecording,
  } = useRecordingStore();

  const activeManualRecording = useMemo(
    () =>
      recordings.find(
        (recording) => recording.status === 'recording' && recording.metadata.source === 'user',
      ) ?? null,
    [recordings],
  );

  useEffect(() => {
    void loadRecordings();
  }, [loadRecordings]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Recordings</h1>
              <p className="text-sm text-muted-foreground">
                Browser workflows captured from agent runs or manual sessions.
              </p>
            </div>
          </div>

          <Button variant="outline" className="gap-2" onClick={() => void importRecording()}>
            <UploadSimple className="h-4 w-4" />
            Import
          </Button>
        </div>

        <Card className="p-5">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">Manual browser recording</h2>
              <p className="text-sm text-muted-foreground">
                Start a manual session here, then interact in the visible dev-browser Chrome window.
                Stop the session back in Accomplish when you are done.
              </p>
            </div>

            {activeManualRecording ? (
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="text-sm text-muted-foreground">
                  Recording{' '}
                  <span className="font-medium text-foreground">{activeManualRecording.name}</span>{' '}
                  is live with {activeManualRecording.metadata.stepCount} captured steps.
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/recordings/${activeManualRecording.id}`)}
                  >
                    Open
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void stopManualRecording(activeManualRecording.id)}
                  >
                    Stop manual recording
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]">
                <Input
                  value={manualRecordingName}
                  onChange={(event) => setManualRecordingName(event.target.value)}
                  placeholder="Recording name (optional)"
                />
                <Input
                  value={manualRecordingUrl}
                  onChange={(event) => setManualRecordingUrl(event.target.value)}
                  placeholder="https://example.com (optional start URL)"
                />
                <Button
                  onClick={() => {
                    void startManualRecording(
                      manualRecordingName.trim() || undefined,
                      manualRecordingUrl.trim() || undefined,
                    ).catch(() => {});
                  }}
                >
                  Start manual recording
                </Button>
              </div>
            )}
          </div>
        </Card>

        {error && <Card className="p-4 text-sm text-destructive">{error}</Card>}

        {isLoading ? (
          <Card className="p-6 text-sm text-muted-foreground">Loading recordings...</Card>
        ) : recordings.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">
            No recordings yet. Start a task, then use the record control in the execution view.
          </Card>
        ) : (
          <div className="grid gap-4">
            {recordings.map((recording) => (
              <Card key={recording.id} className="p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">{recording.name}</h2>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {recording.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      <span>{recording.metadata.stepCount} steps</span>
                      <span>{Math.round(recording.metadata.durationMs / 1000)}s</span>
                      <span>{formatDate(recording.updatedAt)}</span>
                      {recording.metadata.sourceTaskId && (
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => navigate(`/execution/${recording.metadata.sourceTaskId}`)}
                        >
                          Task {recording.metadata.sourceTaskId.slice(0, 8)}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigate(`/recordings/${recording.id}`)}
                    >
                      Open
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => void exportRecording(recording.id)}
                    >
                      <DownloadSimple className="h-4 w-4" />
                      Export
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 text-destructive hover:text-destructive"
                      onClick={() => void deleteRecording(recording.id)}
                    >
                      <Trash className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

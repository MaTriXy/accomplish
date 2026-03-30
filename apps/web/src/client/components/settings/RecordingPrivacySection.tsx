import type { ChangeEvent } from 'react';
import type { PrivacyConfig } from '@accomplish_ai/agent-core/common';
import { Input } from '@/components/ui/input';

interface RecordingPrivacySectionProps {
  config: PrivacyConfig | null;
  onChange: (next: PrivacyConfig) => void;
}

function ToggleCard({
  title,
  description,
  checked,
  onToggle,
  testId,
}: {
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="font-medium text-foreground">{title}</div>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <button
          role="switch"
          aria-checked={checked}
          data-testid={testId}
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
            checked ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
              checked ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </div>
  );
}

export function RecordingPrivacySection({ config, onChange }: RecordingPrivacySectionProps) {
  if (!config) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        Loading recording privacy settings...
      </div>
    );
  }

  const handleCustomKeysChange = (event: ChangeEvent<HTMLInputElement>) => {
    const customSensitiveKeys = event.target.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    onChange({ ...config, customSensitiveKeys });
  };

  const handleScreenshotDimensionChange =
    (key: 'maxScreenshotWidth' | 'maxScreenshotHeight') =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = Math.max(Number.parseInt(event.target.value, 10) || 0, 0);
      onChange({ ...config, [key]: nextValue });
    };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Session Recording
        </h4>
        <div className="space-y-3">
          <ToggleCard
            title="Enable session recording"
            description="Allow task runs to capture browser-tool actions into reusable recordings."
            checked={config.enabled}
            onToggle={() => onChange({ ...config, enabled: !config.enabled })}
            testId="settings-recording-enabled-toggle"
          />
          <ToggleCard
            title="Record agent reasoning"
            description="Store the agent reasoning text alongside recorded steps when it is available."
            checked={config.recordAgentReasoning}
            onToggle={() =>
              onChange({
                ...config,
                recordAgentReasoning: !config.recordAgentReasoning,
              })
            }
          />
          <ToggleCard
            title="Redact email addresses"
            description="Replace detected email addresses before they are written into a recording."
            checked={config.redactEmails}
            onToggle={() => onChange({ ...config, redactEmails: !config.redactEmails })}
          />
          <ToggleCard
            title="Redact secrets and tokens"
            description="Mask API keys, bearer tokens, and other secret-like values in recorded inputs."
            checked={config.redactSecrets}
            onToggle={() => onChange({ ...config, redactSecrets: !config.redactSecrets })}
          />
          <ToggleCard
            title="Redact sensitive URL parameters"
            description="Strip query-string values for keys like token, auth, password, or session."
            checked={config.redactUrlQueryParams}
            onToggle={() =>
              onChange({
                ...config,
                redactUrlQueryParams: !config.redactUrlQueryParams,
              })
            }
          />
          <ToggleCard
            title="Redact all form inputs"
            description="Mask every typed or selected form value, not just fields that look sensitive."
            checked={config.redactAllFormInputs}
            onToggle={() =>
              onChange({
                ...config,
                redactAllFormInputs: !config.redactAllFormInputs,
              })
            }
          />
          <ToggleCard
            title="Capture manual screenshot keyframes"
            description="Attach scrubbed JPEG keyframes to manual browser recordings for navigation, click, and form steps."
            checked={config.captureScreenshots}
            onToggle={() =>
              onChange({
                ...config,
                captureScreenshots: !config.captureScreenshots,
              })
            }
          />
          <ToggleCard
            title="Blur the full screenshot"
            description="Apply a full-viewport blur to every captured keyframe instead of masking only sensitive fields."
            checked={config.blurAllScreenshots}
            onToggle={() =>
              onChange({
                ...config,
                blurAllScreenshots: !config.blurAllScreenshots,
              })
            }
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="font-medium text-foreground">Custom sensitive keys</div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Comma-separated field hints and URL keys that should always be treated as sensitive.
        </p>
        <Input
          className="mt-4"
          value={config.customSensitiveKeys.join(', ')}
          onChange={handleCustomKeysChange}
          placeholder="token, auth, password"
        />
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="font-medium text-foreground">Screenshot keyframe size</div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Manual keyframes are downscaled before storage to keep recordings compact.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Max Width
            </label>
            <Input
              inputMode="numeric"
              value={String(config.maxScreenshotWidth)}
              onChange={handleScreenshotDimensionChange('maxScreenshotWidth')}
              placeholder="960"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Max Height
            </label>
            <Input
              inputMode="numeric"
              value={String(config.maxScreenshotHeight)}
              onChange={handleScreenshotDimensionChange('maxScreenshotHeight')}
              placeholder="540"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

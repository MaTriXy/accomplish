import { useTranslation } from 'react-i18next';
import type { PrivacyConfig } from '@accomplish_ai/agent-core';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { DebugSection } from '@/components/settings/DebugSection';
import { DaemonSection } from '@/components/settings/DaemonSection';
import { RecordingPrivacySection } from '@/components/settings/RecordingPrivacySection';

interface GeneralTabProps {
  notificationsEnabled: boolean;
  onNotificationsToggle: () => void;
  debugMode: boolean;
  onDebugToggle: () => void;
  recordingPrivacyConfig: PrivacyConfig | null;
  onRecordingPrivacyConfigChange: (config: PrivacyConfig) => void;
}

export function GeneralTab({
  notificationsEnabled,
  onNotificationsToggle,
  debugMode,
  onDebugToggle,
  recordingPrivacyConfig,
  onRecordingPrivacyConfigChange,
}: GeneralTabProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <section>
        <NotificationsSection enabled={notificationsEnabled} onToggle={onNotificationsToggle} />
      </section>

      <section>
        <DaemonSection />
      </section>

      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
          {t('developer.title')}
        </h4>
        <DebugSection debugMode={debugMode} onDebugToggle={onDebugToggle} />
      </section>

      <section>
        <RecordingPrivacySection
          config={recordingPrivacyConfig}
          onChange={onRecordingPrivacyConfigChange}
        />
      </section>
    </div>
  );
}

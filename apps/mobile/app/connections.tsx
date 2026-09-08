/**
 * Connected data.
 *
 * Every provider states what it reads before the athlete connects it, and
 * disconnection offers an explicit choice about whether the imported data goes
 * with it. Deletion copy says exactly what will and will not be removed —
 * a run corroborated by two services survives losing one of them.
 */

import React, { useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import {
  collectForIngest,
  isHealthKitAvailable,
  requestAuthorization,
} from '@running/health-kit';

import { api, type Connection } from '../src/lib/api';
import { useQuery } from '../src/lib/session';
import { spacing } from '../src/design/tokens';
import { useTheme } from '../src/design/theme';
import {
  Button,
  Card,
  Divider,
  ErrorState,
  LoadingState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../src/components/primitives';
import { StatusDot } from '../src/components/metrics';

export default function ConnectionsScreen(): React.ReactElement {
  const theme = useTheme();
  const connections = useQuery<{ connections: Connection[] }>(() => api.connections(), []);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const connect = async (connection: Connection): Promise<void> => {
    setBusy(connection.provider);
    setNotice(undefined);
    try {
      // Apple Health is authorised on-device, not through a browser.
      if (connection.provider === 'healthkit') {
        if (!isHealthKitAvailable()) {
          setNotice('Apple Health is only available on iPhone.');
          return;
        }
        const result = await requestAuthorization();
        if (!result.granted) {
          setNotice(result.reason ?? 'Apple Health permission was not granted.');
          return;
        }
        await api.connect('healthkit');
        await importHealthKit();
        return;
      }

      const { data } = await api.connect(connection.provider);

      if (data.connected) {
        setNotice(data.message ?? `${connection.displayName} connected.`);
      } else if (data.authorizationUrl) {
        // The OAuth flow runs in a system browser, so the app never sees the
        // athlete's provider credentials.
        await WebBrowser.openAuthSessionAsync(data.authorizationUrl, 'runningos://');
      }

      await connections.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not connect.');
    } finally {
      setBusy(undefined);
    }
  };

  /** Read on-device and push to the ingest endpoint. */
  const importHealthKit = async (): Promise<void> => {
    const since = new Date(Date.now() - 365 * 86_400_000);
    const collected = await collectForIngest({ since });

    if (collected.workouts.length === 0 && collected.samples.length === 0) {
      // Cannot distinguish "denied" from "no data" — iOS does not disclose it.
      setNotice(
        'No Apple Health data was returned. If you granted permission, there may be nothing recorded in this period.',
      );
      return;
    }

    const { data } = await api.ingestHealthKit(collected);
    setNotice(
      `Imported ${data.ingested} Apple Health records${
        data.duplicatesMerged > 0 ? `, merging ${data.duplicatesMerged} duplicates` : ''
      }.`,
    );
    await connections.refresh();
  };

  const sync = async (provider: string): Promise<void> => {
    setBusy(provider);
    setNotice(undefined);
    try {
      if (provider === 'healthkit') {
        await importHealthKit();
        return;
      }
      const { data } = await api.sync(provider, true);
      setNotice(
        data.errors.length > 0
          ? data.errors[0]!
          : `Synced ${data.recordsFetched} records${
              data.duplicatesMerged > 0 ? `, merged ${data.duplicatesMerged} duplicates` : ''
            }.`,
      );
      await connections.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Sync failed.');
    } finally {
      setBusy(undefined);
    }
  };

  const disconnect = (connection: Connection): void => {
    Alert.alert(
      `Disconnect ${connection.displayName}?`,
      'Choose whether to also delete the data imported from this source. Workouts that were also recorded by another connected service will be kept, with this source removed from them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect only',
          onPress: () => void runDisconnect(connection.provider, false),
        },
        {
          text: 'Disconnect and delete',
          style: 'destructive',
          onPress: () => void runDisconnect(connection.provider, true),
        },
      ],
    );
  };

  const runDisconnect = async (provider: string, deleteData: boolean): Promise<void> => {
    setBusy(provider);
    try {
      const { data } = await api.disconnect(provider, deleteData);
      setNotice(
        deleteData
          ? `Disconnected and removed ${data.recordsDeleted} records.`
          : 'Disconnected. Your imported history was kept.',
      );
      await connections.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not disconnect.');
    } finally {
      setBusy(undefined);
    }
  };

  if (connections.loading && !connections.data) return <LoadingState />;

  if (!connections.data) {
    return (
      <Screen>
        <ErrorState
          message={connections.error ?? 'Could not load your connections.'}
          onRetry={() => void connections.refresh()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={connections.loading}
          onRefresh={() => void connections.refresh()}
          tintColor={theme.color.textTertiary}
        />
      }
    >
      <Stack gap={spacing.lg}>
        {notice ? (
          <Card>
            <Type variant="body" tone="secondary">
              {notice}
            </Type>
          </Card>
        ) : null}

        {connections.data.connections.map((connection) => (
          <View key={connection.provider}>
            <SectionHeader title={connection.displayName} />
            <Card>
              <Stack gap={spacing.md}>
                <Stack direction="row" justify="space-between" align="center">
                  <StatusDot status={connection.status} />
                  {connection.lastSyncedAt ? (
                    <Type variant="caption" tone="tertiary">
                      Synced {relativeTime(connection.lastSyncedAt)}
                    </Type>
                  ) : null}
                </Stack>

                {connection.lastSyncError ? (
                  <Type variant="caption" tone="caution">
                    {connection.lastSyncError}
                  </Type>
                ) : null}

                <Divider />

                {/* Stated before connecting, not buried in a policy. */}
                <Stack gap={spacing.xs}>
                  <Type variant="overline" tone="tertiary">
                    WHAT THIS READS
                  </Type>
                  {connection.dataDescription.map((item) => (
                    <Type key={item} variant="caption" tone="secondary">
                      • {item}
                    </Type>
                  ))}
                </Stack>

                {!connection.isConfigured ? (
                  <Type variant="caption" tone="caution">
                    Not configured on this server. Add its client credentials to enable it.
                  </Type>
                ) : null}

                <Stack gap={spacing.sm}>
                  {connection.status === 'connected' ? (
                    <>
                      <Button
                        label="Sync now"
                        variant="secondary"
                        loading={busy === connection.provider}
                        onPress={() => void sync(connection.provider)}
                      />
                      <Button
                        label="Disconnect"
                        variant="ghost"
                        onPress={() => disconnect(connection)}
                      />
                    </>
                  ) : (
                    <Button
                      label={connection.status === 'expired' ? 'Reconnect' : 'Connect'}
                      loading={busy === connection.provider}
                      disabled={!connection.isConfigured}
                      onPress={() => void connect(connection)}
                    />
                  )}
                </Stack>
              </Stack>
            </Card>
          </View>
        ))}

        <Card>
          <Stack gap={spacing.sm}>
            <Type variant="bodyStrong">About your data</Type>
            <Type variant="caption" tone="secondary">
              Provider credentials are held on our server, encrypted, and are never stored in this
              app. Disconnecting revokes our access with that provider. Deleting removes the records
              that came from it — workouts also seen by another connected service are kept, with
              that source&apos;s contribution removed.
            </Type>
          </Stack>
        </Card>
      </Stack>
    </Screen>
  );
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

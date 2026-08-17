/**
 * Coach.
 *
 * A conversation grounded in the athlete's own data. Responses arrive with the
 * data they were built from and, when the deterministic responder answered
 * instead of a language model, the UI says so rather than implying more
 * sophistication than was used.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import { api, type CoachResponse } from '../../src/lib/api';
import { radius, spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import { Button, Card, Chip, Stack, Type } from '../../src/components/primitives';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  structured?: CoachResponse;
}

/** Starter questions, so an empty coach tab is not a blank box. */
const SUGGESTIONS = [
  'Why is today’s run easy?',
  'Am I getting faster?',
  'Should I run tomorrow?',
  'Can I increase my mileage?',
  'Why am I tired?',
];

export default function CoachScreen(): React.ReactElement {
  const theme = useTheme();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.coachHistory();
        setMessages(
          data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
        );
      } catch {
        // History is a nicety; an empty coach still works.
      }
    })();
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setInput('');
      setSending(true);
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: 'user', content: trimmed },
      ]);

      try {
        const { data } = await api.coachMessage(trimmed);
        setMessages((prev) => [
          ...prev,
          {
            id: `reply-${Date.now()}`,
            role: 'assistant',
            content: data.answer,
            structured: data,
          },
        ]);
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content:
              error instanceof Error
                ? error.message
                : 'I could not reach your training data just now.',
          },
        ]);
      } finally {
        setSending(false);
        requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      }
    },
    [sending],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.color.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messages.length === 0 ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">Ask your coach</Type>
              <Type variant="body" tone="secondary">
                Answers come from your own training data. If the data isn&apos;t there, your coach
                will say so rather than guess.
              </Type>
            </Stack>
            <Stack gap={spacing.sm}>
              {SUGGESTIONS.map((suggestion) => (
                <Card key={suggestion} onPress={() => void send(suggestion)}>
                  <Type variant="body" tone="accent">
                    {suggestion}
                  </Type>
                </Card>
              ))}
            </Stack>
          </Stack>
        ) : null}

        {messages.map((message) =>
          message.role === 'user' ? (
            <View
              key={message.id}
              style={{
                alignSelf: 'flex-end',
                maxWidth: '85%',
                backgroundColor: theme.color.accent,
                borderRadius: radius.lg,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
              }}
            >
              <Type variant="body" style={{ color: '#fff' }}>
                {message.content}
              </Type>
            </View>
          ) : (
            <View key={message.id} style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
              <Card>
                <Stack gap={spacing.md}>
                  <Type variant="body">{message.content}</Type>

                  {message.structured?.keyMetrics?.length ? (
                    <Stack gap={spacing.xs}>
                      {message.structured.keyMetrics.map((metric) => (
                        <Stack
                          key={metric.label}
                          direction="row"
                          justify="space-between"
                          align="center"
                        >
                          <Type variant="caption" tone="secondary">
                            {metric.label}
                          </Type>
                          <Type variant="bodyStrong">{metric.value}</Type>
                        </Stack>
                      ))}
                    </Stack>
                  ) : null}

                  {message.structured?.recommendation ? (
                    <Type variant="caption" tone="accent">
                      {message.structured.recommendation}
                    </Type>
                  ) : null}

                  {/* Provenance: what the answer was grounded in. */}
                  {message.structured?.dataUsed?.length ? (
                    <Stack direction="row" gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
                      {message.structured.dataUsed.map((item) => (
                        <Chip key={item} label={item} />
                      ))}
                    </Stack>
                  ) : null}

                  {message.structured?.warnings?.length ? (
                    <Stack gap={2}>
                      {message.structured.warnings.map((warning) => (
                        <Type key={warning} variant="caption" tone="caution">
                          Missing: {warning}
                        </Type>
                      ))}
                    </Stack>
                  ) : null}

                  {message.structured?.generatedWithoutLlm ? (
                    // Honesty about how the answer was produced.
                    <Type variant="caption" tone="tertiary">
                      Answered directly from your data (no AI model configured).
                    </Type>
                  ) : null}
                </Stack>
              </Card>
            </View>
          ),
        )}

        {sending ? (
          <Type variant="caption" tone="tertiary">
            Thinking…
          </Type>
        ) : null}
      </ScrollView>

      <View
        style={{
          flexDirection: 'row',
          gap: spacing.sm,
          padding: spacing.lg,
          borderTopWidth: 1,
          borderTopColor: theme.color.border,
          backgroundColor: theme.color.surface,
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your training"
          placeholderTextColor={theme.color.textTertiary}
          accessibilityLabel="Message your coach"
          style={{
            flex: 1,
            minHeight: 48,
            paddingHorizontal: spacing.md,
            borderRadius: radius.md,
            backgroundColor: theme.color.surfaceRaised,
            color: theme.color.text,
            borderWidth: 1,
            borderColor: theme.color.border,
          }}
          onSubmitEditing={() => void send(input)}
          returnKeyType="send"
        />
        <Button label="Send" onPress={() => void send(input)} loading={sending} />
      </View>
    </KeyboardAvoidingView>
  );
}

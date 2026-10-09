import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTranslation } from "react-i18next";
import { useAskPranaChat } from "../context/ask-prana-chat-context";
import type { AskPranaSessionSummary } from "../services/ask-prana-messages";

const colors = {
  primary: "#4F8CF7",
  white: "#F4F7FA",
  text: "#EAF1FF",
  muted: "#A1A9B8",
  border: "#2A303C",
  soft: "#1B2330",
  overlay: "rgba(2, 6, 12, 0.7)",
  danger: "#EF4444",
};

const DRAWER_WIDTH = Math.min(Dimensions.get("window").width * 0.88, 360);

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatActivityTime(iso: string) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    return "";
  }

  return when.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function groupLabel(iso: string, t: (key: string) => string) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    return t("askPrana.historyEarlier");
  }

  const today = startOfDay(new Date());
  const target = startOfDay(when);
  const dayMs = 24 * 60 * 60 * 1000;

  if (target === today) {
    return t("askPrana.historyToday");
  }
  if (target === today - dayMs) {
    return t("askPrana.historyYesterday");
  }
  return t("askPrana.historyEarlier");
}

type Props = {
  visible: boolean;
  onClose: () => void;
  pondName: string;
};

export function AskPranaChatHistoryDrawer({ visible, onClose, pondName }: Props) {
  const { t } = useTranslation();
  const {
    activeSessionId,
    listConversations,
    startNewConversation,
    openConversation,
    renameConversation,
    deleteConversation,
  } = useAskPranaChat();

  const [sessions, setSessions] = useState<AskPranaSessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [slide] = useState(() => new Animated.Value(DRAWER_WIDTH));

  const loadHistory = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const next = await listConversations();
      setSessions(next);
    } catch {
      setSessions([]);
      setLoadError(t("askPrana.historyEmpty"));
    } finally {
      setIsLoading(false);
    }
  }, [listConversations, t]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    Animated.timing(slide, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start();

    void loadHistory();
  }, [visible, slide, loadHistory]);

  const closeDrawer = () => {
    Animated.timing(slide, {
      toValue: DRAWER_WIDTH,
      duration: 180,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        onClose();
      }
    });
  };

  const grouped = useMemo(() => {
    const order = [
      t("askPrana.historyToday"),
      t("askPrana.historyYesterday"),
      t("askPrana.historyEarlier"),
    ];
    const map = new Map<string, AskPranaSessionSummary[]>();

    for (const session of sessions) {
      const label = groupLabel(session.lastActivity || session.createdAt, t);
      const list = map.get(label) ?? [];
      list.push(session);
      map.set(label, list);
    }

    return order
      .map((label) => ({ label, items: map.get(label) ?? [] }))
      .filter((group) => group.items.length > 0);
  }, [sessions, t]);

  const handleNewConversation = async () => {
    await startNewConversation();
    closeDrawer();
  };

  const handleOpen = async (sessionId: string) => {
    await openConversation(sessionId);
    closeDrawer();
  };

  const handleDelete = (session: AskPranaSessionSummary) => {
    Alert.alert(
      t("askPrana.deleteConversationTitle"),
      t("askPrana.deleteConversationBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("askPrana.delete"),
          style: "destructive",
          onPress: () => {
            void (async () => {
              const { error } = await deleteConversation(session.id);
              if (error) {
                Alert.alert(t("common.error"), error.message);
                return;
              }
              await loadHistory();
            })();
          },
        },
      ],
    );
  };

  const beginRename = (session: AskPranaSessionSummary) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  const saveRename = async () => {
    if (!renamingId) {
      return;
    }

    const { error } = await renameConversation(renamingId, renameValue);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      return;
    }

    setRenamingId(null);
    setRenameValue("");
    await loadHistory();
  };

  if (!visible) {
    return null;
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={closeDrawer}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={closeDrawer} />

        <Animated.View
          style={[
            styles.drawer,
            { transform: [{ translateX: slide }] },
          ]}
        >
          <View style={styles.drawerInner}>
            <Pressable
              onPress={() => void handleNewConversation()}
              style={({ pressed }) => [
                styles.newButton,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
            >
              <Feather name="zap" size={16} color={colors.primary} />
              <Text style={styles.newButtonText}>
                {t("askPrana.newConversation")}
              </Text>
            </Pressable>

            {isLoading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
              >
                {loadError ? (
                  <Text style={styles.emptyText}>{loadError}</Text>
                ) : grouped.length === 0 ? (
                  <Text style={styles.emptyText}>
                    {t("askPrana.historyEmpty")}
                  </Text>
                ) : (
                  grouped.map((group) => (
                    <View key={group.label} style={styles.group}>
                      <Text style={styles.groupLabel}>{group.label}</Text>
                      {group.items.map((session) => {
                        const selected = session.id === activeSessionId;
                        return (
                          <Pressable
                            key={session.id}
                            onPress={() => void handleOpen(session.id)}
                            onLongPress={() => beginRename(session)}
                            style={({ pressed }) => [
                              styles.item,
                              selected && styles.itemSelected,
                              pressed && styles.pressed,
                            ]}
                          >
                            <View style={styles.itemCopy}>
                              <Text style={styles.itemTitle} numberOfLines={1}>
                                {session.title}
                              </Text>
                              <Text style={styles.itemPreview} numberOfLines={1}>
                                {pondName}
                                {session.preview
                                  ? ` • ${session.preview}`
                                  : ""}
                              </Text>
                              {formatActivityTime(
                                session.lastActivity || session.createdAt,
                              ) ? (
                                <Text style={styles.itemTime}>
                                  {formatActivityTime(
                                    session.lastActivity || session.createdAt,
                                  )}
                                </Text>
                              ) : null}
                            </View>
                            <Pressable
                              onPress={() => handleDelete(session)}
                              hitSlop={8}
                              accessibilityRole="button"
                              accessibilityLabel={t("askPrana.delete")}
                            >
                              <Feather
                                name="trash-2"
                                size={15}
                                color={colors.muted}
                              />
                            </Pressable>
                          </Pressable>
                        );
                      })}
                    </View>
                  ))
                )}
              </ScrollView>
            )}

            <View style={styles.footer}>
              <View style={styles.footerAvatar}>
                <Text style={styles.footerAvatarText}>A</Text>
              </View>
              <View>
                <Text style={styles.footerTitle}>Aquaprana</Text>
                <Text style={styles.footerSubtitle}>
                  {t("askPrana.assistantLabel")}
                </Text>
              </View>
            </View>
          </View>
        </Animated.View>
      </View>

      <Modal
        visible={renamingId != null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenamingId(null)}
      >
        <Pressable
          style={styles.renameOverlay}
          onPress={() => setRenamingId(null)}
        >
          <Pressable
            style={styles.renameCard}
            onPress={(event) => event.stopPropagation()}
          >
            <Text style={styles.renameTitle}>{t("askPrana.renameConversation")}</Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              style={styles.renameInput}
              autoFocus
              placeholder={t("askPrana.renamePlaceholder")}
              placeholderTextColor={colors.muted}
            />
            <View style={styles.renameActions}>
              <Pressable
                onPress={() => setRenamingId(null)}
                style={styles.renameCancel}
              >
                <Text style={styles.renameCancelText}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable onPress={() => void saveRename()} style={styles.renameSave}>
                <Text style={styles.renameSaveText}>{t("common.save")}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  drawer: {
    width: DRAWER_WIDTH,
    height: "100%",
    backgroundColor: "#111827",
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    overflow: "hidden",
  },
  drawerInner: { flex: 1, paddingTop: 18, paddingHorizontal: 14, backgroundColor: "#111827" },
  newButton: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#1B2330",
  },
  newButtonText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "700",
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { flex: 1, marginTop: 16 },
  listContent: { paddingBottom: 20, gap: 16 },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "500",
    paddingVertical: 24,
    textAlign: "center",
  },
  group: { gap: 6 },
  groupLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 2,
    paddingHorizontal: 4,
  },
  item: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  itemSelected: { backgroundColor: colors.soft },
  itemCopy: { flex: 1, gap: 3 },
  itemTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  itemPreview: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  itemTime: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "500",
    marginTop: 1,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  footerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  footerAvatarText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: "800",
  },
  footerTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
  },
  footerSubtitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  pressed: { opacity: 0.86 },
  renameOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  renameCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  renameTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
  },
  renameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  renameActions: { flexDirection: "row", gap: 10 },
  renameCancel: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  renameCancelText: { color: colors.text, fontWeight: "700" },
  renameSave: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  renameSaveText: { color: colors.white, fontWeight: "800" },
});

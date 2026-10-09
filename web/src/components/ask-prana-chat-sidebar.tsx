import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "./user-avatar";
import { AskPranaLogo } from "./ask-prana-logo";
import { useProfile } from "../context/profile-context";
import { useAskPranaChat } from "../context/ask-prana-chat-context";
import { ASK_PRANA_FONT_FAMILY } from "../constants/ask-prana-typography";
import type { AskPranaSessionSummary } from "../services/ask-prana-messages";
import { useAskPranaDisplayTranslation } from "../lib/ask-prana-display-translation";

const colors = {
  accent: "#4F8CF7",
  background: "#171717",
  border: "#2F2F2F",
  danger: "#F87171",
  muted: "#A0A0A0",
  selected: "#2A2A2A",
  text: "#F5F5F5",
  white: "#FFFFFF",
};

const PINNED_CHATS_STORAGE_KEY = "ask-prana:pinned-chat-ids";

const drawerRootWeb: ViewStyle | null =
  Platform.OS === "web"
    ? ({
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      } as ViewStyle)
    : null;

function dateGroup(value: string, t: (key: string) => string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("askPrana.historyOlder");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - target.getTime()) / 86_400_000);

  if (days <= 0) return t("askPrana.historyToday");
  if (days === 1) return t("askPrana.historyYesterday");
  if (days <= 7) return t("askPrana.historyPrevious7Days");
  if (days <= 30) return t("askPrana.historyPrevious30Days");
  return t("askPrana.historyOlder");
}

type Props = {
  visible: boolean;
  isDesktop: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onConversationDeleted: (sessionId: string) => void;
};

type ChatHistoryContextMenuProps = {
  pinned: boolean;
  opensUpward: boolean;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function ChatHistoryContextMenu({
  pinned,
  opensUpward,
  onTogglePin,
  onEdit,
  onDelete,
}: ChatHistoryContextMenuProps) {
  const { t } = useTranslation();
  return (
    <View
      nativeID="ask-prana-chat-history-menu"
      style={[styles.itemMenu, opensUpward && styles.itemMenuUpward]}
    >
      <Pressable
        onPress={onTogglePin}
        style={({ hovered, pressed }) => [
          styles.menuAction,
          hovered && styles.menuActionHovered,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={pinned ? t("askPrana.unpinChat") : t("askPrana.pinChat")}
      >
        <Feather name="bookmark" size={17} color={colors.text} />
        <Text style={styles.menuActionText}>{pinned ? t("askPrana.unpinChat") : t("askPrana.pinChat")}</Text>
      </Pressable>
      <Pressable
        onPress={onEdit}
        style={({ hovered, pressed }) => [
          styles.menuAction,
          hovered && styles.menuActionHovered,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t("askPrana.edit")}
      >
        <Feather name="edit-2" size={17} color={colors.text} />
        <Text style={styles.menuActionText}>{t("askPrana.edit")}</Text>
      </Pressable>
      <Pressable
        onPress={onDelete}
        style={({ hovered, pressed }) => [
          styles.menuAction,
          hovered && styles.deleteActionHovered,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t("askPrana.delete")}
      >
        <Feather name="trash-2" size={17} color={colors.danger} />
        <Text style={[styles.menuActionText, styles.deleteText]}>{t("askPrana.delete")}</Text>
      </Pressable>
    </View>
  );
}

export function AskPranaChatSidebar({
  visible,
  isDesktop,
  onClose,
  onNewChat,
  onConversationDeleted,
}: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const { displayName, avatarUrl, avatarUpdatedAt } = useProfile();
  const {
    activeSessionId,
    listConversationPage,
    conversationActivity,
    startNewConversation,
    openConversation,
    renameConversation,
    deleteConversation,
  } = useAskPranaChat();

  const [sessions, setSessions] = useState<AskPranaSessionSummary[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // i18n key, so the message follows the selected language.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [menuSource, setMenuSource] = useState<"pinned" | "history" | null>(null);
  const [renamingSession, setRenamingSession] =
    useState<AskPranaSessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingSession, setDeletingSession] =
    useState<AskPranaSessionSummary | null>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>([]);
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const historyRequestIdRef = useRef(0);
  const historyInflightRef = useRef<Promise<void> | null>(null);
  const normalizedSearch = searchText.trim().toLocaleLowerCase();

  useEffect(() => {
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(PINNED_CHATS_STORAGE_KEY);
        const parsed: unknown = stored ? JSON.parse(stored) : [];
        if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
          setPinnedSessionIds(parsed);
        }
      } catch {
        // A local preference must never prevent history from loading.
      } finally {
        setPinsLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!menuSessionId || Platform.OS !== "web") return;
    const closeMenu = () => {
      setMenuSessionId(null);
      setMenuSource(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest("#ask-prana-chat-history-menu") ||
        target?.closest("[id^='ask-prana-menu-trigger-']")
      ) {
        return;
      }
      closeMenu();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("mousedown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("mousedown", closeOnPointerDown);
    };
  }, [menuSessionId]);

  const loadHistory = useCallback(
    async (cursor?: string | null) => {
      if (!cursor && historyInflightRef.current) return historyInflightRef.current;
      const requestId = ++historyRequestIdRef.current;
      const started = Date.now();
      if (cursor) setIsLoadingMore(true);
      else setIsLoading(true);
      setLoadError(null);
      const run = (async () => {
        try {
          const page = await listConversationPage(cursor);
          if (requestId !== historyRequestIdRef.current) return;
          setSessions((current) => {
            if (!cursor) return page.sessions;
            const seen = new Set(current.map((session) => session.id));
            return [...current, ...page.sessions.filter((session) => !seen.has(session.id))];
          });
          setNextCursor(page.nextCursor);
          console.info("[history] page", {
            ms: Date.now() - started,
            count: page.sessions.length,
            cursor: Boolean(cursor),
          });
        } catch {
          if (requestId !== historyRequestIdRef.current) return;
          setLoadError("askPrana.historyLoadError");
        } finally {
          if (requestId === historyRequestIdRef.current) {
            setIsLoading(false);
            setIsLoadingMore(false);
          }
        }
      })();
      if (!cursor) historyInflightRef.current = run;
      await run;
      if (!cursor && historyInflightRef.current === run) historyInflightRef.current = null;
    },
    [listConversationPage],
  );

  useEffect(() => {
    setSessions([]);
    setNextCursor(null);
    setLoadError(null);
  }, [listConversationPage]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => void loadHistory(), 0);
    return () => clearTimeout(timer);
  }, [loadHistory, visible]);

  useEffect(() => {
    if (!conversationActivity) return;
    setSessions((current) => {
      const existing = current.find((session) => session.id === conversationActivity.id);
      const updated: AskPranaSessionSummary = {
        id: conversationActivity.id,
        pondId: existing?.pondId ?? null,
        title: existing?.title || conversationActivity.preview || "New conversation",
        preview: conversationActivity.preview,
        createdAt: existing?.createdAt || conversationActivity.lastActivity,
        lastActivity: conversationActivity.lastActivity,
      };
      return [updated, ...current.filter((session) => session.id !== conversationActivity.id)];
    });
  }, [conversationActivity]);

  // Every loaded session (pinned, grouped and search results alike) is
  // translated into the selected language; originals are never shown as a
  // fallback while another language is selected.
  const { displayText, getStatus } = useAskPranaDisplayTranslation(
    sessions.flatMap((session) => [session.title, session.preview].filter(Boolean)),
    "visible",
    { prefetchOtherLanguages: false },
  );

  const visibleSessions = useMemo(() => {
    if (!normalizedSearch) return sessions;
    return sessions.filter((session) => {
      // Match the displayed (selected-language) text and the stored original.
      return [
        displayText(session.title),
        session.preview ? displayText(session.preview) : "",
        session.title,
        session.preview,
      ].some((value) => value?.trim().toLocaleLowerCase().includes(normalizedSearch));
    });
  }, [displayText, normalizedSearch, sessions]);

  const pinnedSessions = useMemo(
    () => visibleSessions.filter((session) => pinnedSessionIds.includes(session.id)),
    [pinnedSessionIds, visibleSessions],
  );

  // A session belongs to either Pinned or its chronological group, never both.
  // Filter before grouping so search results and normal history cannot duplicate
  // a pinned conversation.
  const unpinnedSessions = useMemo(
    () => visibleSessions.filter((session) => !pinnedSessionIds.includes(session.id)),
    [pinnedSessionIds, visibleSessions],
  );

  const groupedSessions = useMemo(() => {
    const groupOrder = [
      t("askPrana.historyToday"),
      t("askPrana.historyYesterday"),
      t("askPrana.historyPrevious7Days"),
      t("askPrana.historyPrevious30Days"),
      t("askPrana.historyOlder"),
    ];
    const groups = new Map<string, AskPranaSessionSummary[]>();
    for (const session of unpinnedSessions) {
      const label = dateGroup(session.lastActivity || session.createdAt, t);
      const items = groups.get(label) ?? [];
      items.push(session);
      groups.set(label, items);
    }
    return groupOrder.flatMap((label) => {
      const items = groups.get(label);
      return items?.length ? [{ label, items }] : [];
    });
  }, [t, unpinnedSessions]);

  const startNewChat = async () => {
    onNewChat();
    await startNewConversation();
    if (!isDesktop) onClose();
  };

  const openSession = async (sessionId: string) => {
    setMenuSessionId(null);
    setMenuSource(null);
    await openConversation(sessionId);
    if (!isDesktop) onClose();
  };

  const saveRename = async () => {
    if (!renamingSession) return;
    const { error } = await renameConversation(renamingSession.id, renameValue);
    if (error) {
      setLoadError("askPrana.renameError");
      return;
    }
    setRenamingSession(null);
    setRenameValue("");
    await loadHistory();
  };

  const confirmDelete = async () => {
    if (!deletingSession) return;
    const sessionId = deletingSession.id;
    const { error } = await deleteConversation(sessionId);
    if (error) {
      setLoadError("askPrana.deleteError");
      return;
    }
    if (activeSessionId === sessionId) onConversationDeleted(sessionId);
    setPinnedSessionIds((current) => {
      const next = current.filter((id) => id !== sessionId);
      void AsyncStorage.setItem(PINNED_CHATS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setDeletingSession(null);
    setMenuSessionId(null);
    await loadHistory();
  };

  const togglePinned = (sessionId: string) => {
    setPinnedSessionIds((current) => {
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId];
      void AsyncStorage.setItem(PINNED_CHATS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setMenuSessionId(null);
    setMenuSource(null);
  };

  const content = (
    <View style={[styles.sidebar, isDesktop && styles.desktopSidebar]}>
      <View style={styles.topArea}>
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <AskPranaLogo size={30} decorative />
            <Text style={styles.brand}>ASK PRANA</Text>
          </View>
          <Pressable
            onPress={onClose}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={isDesktop ? t("askPrana.collapseSidebar") : t("askPrana.closeHistory")}
          >
            <Feather
              name={isDesktop ? "sidebar" : "x"}
              size={17}
              color={colors.muted}
            />
          </Pressable>
        </View>
        <Pressable
          onPress={() => void startNewChat()}
          style={({ pressed }) => [styles.newChatButton, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Feather name="plus" size={18} color={colors.text} />
          <Text style={styles.newChatText}>{t("askPrana.newConversation")}</Text>
        </Pressable>
        <View style={styles.searchBox}>
          <Feather name="search" size={16} color={colors.muted} />
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder={t("askPrana.searchChats")}
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
            accessibilityLabel={t("askPrana.searchChats")}
            returnKeyType="search"
          />
          {searchText ? (
            <Pressable
              onPress={() => setSearchText("")}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("askPrana.clearSearch")}
            >
              <Feather name="x" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        style={styles.historyList}
        contentContainerStyle={styles.historyContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {sessions.length === 0 && (isLoading || !pinsLoaded) ? (
          <View style={styles.loadingState}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : sessions.length === 0 && loadError ? (
          <Pressable onPress={() => void loadHistory()} accessibilityRole="button">
            <Text style={styles.emptyText}>{t(loadError)}</Text>
          </Pressable>
        ) : groupedSessions.length === 0 && pinnedSessions.length === 0 ? (
          <Text style={styles.emptyText}>
            {normalizedSearch ? t("askPrana.noConversationsFound") : t("askPrana.historyEmpty")}
          </Text>
        ) : (
          <>
          {loadError ? <Text style={styles.emptyText}>{t(loadError)}</Text> : null}
          {pinnedSessions.length > 0 ? (
            <View style={styles.group}>
              <Text style={styles.groupLabel}>{t("askPrana.pinned")}</Text>
              {pinnedSessions.map((session, index) => {
                const menuOpensUpward = index >= pinnedSessions.length - 2;
                return (
                <View
                  key={`pinned-${session.id}`}
                  style={[
                    styles.itemWrap,
                    menuSessionId === session.id && menuSource === "pinned" && styles.itemWrapMenuOpen,
                  ]}
                >
                <Pressable
                  onPress={() => void openSession(session.id)}
                  style={({ pressed, hovered }) => [
                    styles.conversationItem,
                    session.id === activeSessionId && styles.activeItem,
                    hovered && styles.hoveredItem,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.openConversationLabel", { title: displayText(session.title) })}
                >
                  <View style={styles.itemCopy}>
                    <View style={styles.itemTitleRow}>
                      <Feather name="bookmark" size={12} color={colors.muted} />
                      <Text style={styles.itemTitle} numberOfLines={1}>{displayText(session.title)}</Text>
                    </View>
                    <Text style={styles.itemPreview} numberOfLines={1}>
                      {session.preview ? displayText(session.preview) : t("askPrana.conversationFallback")}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const closes = menuSessionId === session.id && menuSource === "pinned";
                    setMenuSessionId(closes ? null : session.id);
                    setMenuSource(closes ? null : "pinned");
                  }}
                  style={({ hovered, pressed }) => [
                    styles.menuButton,
                    hovered && styles.menuButtonHovered,
                    pressed && styles.pressed,
                  ]}
                  hitSlop={6}
                  nativeID={`ask-prana-menu-trigger-${session.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.conversationOptions", { title: displayText(session.title) })}
                >
                  <Feather name="more-horizontal" size={17} color={colors.muted} />
                </Pressable>
                {menuSessionId === session.id && menuSource === "pinned" ? (
                  <ChatHistoryContextMenu
                    pinned
                    opensUpward={menuOpensUpward}
                    onTogglePin={() => togglePinned(session.id)}
                    onEdit={() => {
                      setRenamingSession(session);
                      setRenameValue(getStatus(session.title) === "ready" ? displayText(session.title) : "");
                      setMenuSessionId(null);
                    }}
                    onDelete={() => {
                      setDeletingSession(session);
                      setMenuSessionId(null);
                    }}
                  />
                ) : null}
                </View>
                );
              })}
            </View>
          ) : null}
          {groupedSessions.map((group) => (
            <View key={group.label} style={styles.group}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              {group.items.map((session, index) => {
                const menuOpensUpward = index >= group.items.length - 2;
                return (
                <View
                  key={session.id}
                  style={[
                    styles.itemWrap,
                    menuSessionId === session.id && menuSource === "history" && styles.itemWrapMenuOpen,
                  ]}
                >
                  <Pressable
                    onPress={() => void openSession(session.id)}
                    style={({ pressed }) => [
                      styles.conversationItem,
                      session.id === activeSessionId && styles.activeItem,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.openConversationLabel", { title: displayText(session.title) })}
                  >
                    <View style={styles.itemCopy}>
                      <View style={styles.itemTitleRow}>
                        {pinnedSessionIds.includes(session.id) ? (
                          <Feather name="bookmark" size={12} color={colors.muted} />
                        ) : null}
                        <Text style={styles.itemTitle} numberOfLines={1}>{displayText(session.title)}</Text>
                      </View>
                      <Text style={styles.itemPreview} numberOfLines={1}>
                        {session.preview ? displayText(session.preview) : t("askPrana.conversationFallback")}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      const closes = menuSessionId === session.id && menuSource === "history";
                      setMenuSessionId(closes ? null : session.id);
                      setMenuSource(closes ? null : "history");
                    }}
                    style={({ hovered, pressed }) => [
                      styles.menuButton,
                      hovered && styles.menuButtonHovered,
                      pressed && styles.pressed,
                    ]}
                    hitSlop={6}
                    nativeID={`ask-prana-menu-trigger-${session.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.conversationOptions", { title: displayText(session.title) })}
                  >
                    <Feather name="more-horizontal" size={17} color={colors.muted} />
                  </Pressable>
                  {menuSessionId === session.id && menuSource === "history" ? (
                    <ChatHistoryContextMenu
                      pinned={pinnedSessionIds.includes(session.id)}
                      opensUpward={menuOpensUpward}
                      onTogglePin={() => togglePinned(session.id)}
                      onEdit={() => {
                        setRenamingSession(session);
                        setRenameValue(getStatus(session.title) === "ready" ? displayText(session.title) : "");
                        setMenuSessionId(null);
                        setMenuSource(null);
                      }}
                      onDelete={() => {
                        setDeletingSession(session);
                        setMenuSessionId(null);
                        setMenuSource(null);
                      }}
                    />
                  ) : null}
                </View>
                );
              })}
            </View>
          ))}
          {nextCursor ? (
            <Pressable
              onPress={() => void loadHistory(nextCursor)}
              disabled={isLoadingMore}
              style={styles.profileRow}
              accessibilityRole="button"
              accessibilityLabel={t("askPrana.loadMoreHistory")}
            >
              {isLoadingMore ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={styles.emptyText}>{t("askPrana.loadMoreHistory")}</Text>
              )}
            </Pressable>
          ) : null}
          </>
        )}
      </ScrollView>

      <Pressable
        onPress={() => {
          if (!isDesktop) onClose();
          router.push("/edit-profile" as never);
        }}
        style={({ pressed }) => [styles.profileRow, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={t("profile.title")}
      >
        <UserAvatar
          name={displayName}
          avatarUrl={avatarUrl}
          avatarUpdatedAt={avatarUpdatedAt}
          size={36}
          variant="solid"
        />
        <View style={styles.profileCopy}>
          <Text style={styles.profileName} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.profileSubtitle}>{t("askPrana.account")}</Text>
        </View>
        <Feather name="chevron-right" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );

  return (
    <>
      {isDesktop ? (
        visible ? content : null
      ) : (
        <Modal
          visible={visible}
          transparent
          animationType="fade"
          onRequestClose={onClose}
        >
          <View style={[styles.drawerRoot, drawerRootWeb]}>
            <Pressable style={styles.backdrop} onPress={onClose} />
            <View style={styles.mobileDrawer}>{content}</View>
          </View>
        </Modal>
      )}

      <Modal
        visible={renamingSession != null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenamingSession(null)}
      >
        <View style={styles.dialogBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>{t("askPrana.renameConversation")}</Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              style={styles.renameInput}
              autoFocus
              maxLength={60}
              placeholder={t("askPrana.conversationTitle")}
              placeholderTextColor={colors.muted}
            />
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setRenamingSession(null)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable onPress={() => void saveRename()} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>{t("common.save")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={deletingSession != null}
        transparent
        animationType="fade"
        onRequestClose={() => setDeletingSession(null)}
      >
        <View style={styles.dialogBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>{t("askPrana.deleteConversationTitle")}</Text>
            <Text style={styles.dialogBody}>{t("askPrana.deleteConversationBody")}</Text>
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setDeletingSession(null)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable onPress={() => void confirmDelete()} style={styles.deleteButton}>
                <Text style={styles.primaryButtonText}>{t("askPrana.delete")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    flex: 1,
    width: "100%",
    minWidth: 0,
    backgroundColor: colors.background,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  desktopSidebar: {
    width: 280,
    minWidth: 280,
    maxWidth: 320,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 280,
    height: "100%",
  },
  topArea: { gap: 12 },
  brandRow: {
    minHeight: 34,
    paddingHorizontal: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandMark: { flexDirection: "row", alignItems: "center", gap: 10 },
  brand: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 18, lineHeight: 23, fontWeight: "600" },
  iconButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  newChatButton: {
    minHeight: 42,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.selected,
    borderRadius: 8,
  },
  newChatText: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  searchBox: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 7,
    paddingHorizontal: 10,
  },
  searchInput: { flex: 1, color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "400", paddingVertical: 6 },
  historyList: { flex: 1, marginTop: 16, overflow: "visible" },
  historyContent: { paddingBottom: 16, gap: 20, overflow: "visible" },
  loadingState: { paddingVertical: 24, alignItems: "center" },
  emptyText: { color: colors.muted, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 13, padding: 12, lineHeight: 19, fontWeight: "400" },
  group: { gap: 3, overflow: "visible" },
  groupLabel: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    marginBottom: 5,
    paddingHorizontal: 7,
  },
  itemWrap: { position: "relative", flexDirection: "row", alignItems: "center", overflow: "visible", zIndex: 0 },
  itemWrapMenuOpen: { zIndex: 10 },
  conversationItem: {
    minHeight: 42,
    flex: 1,
    minWidth: 0,
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 7,
    justifyContent: "center",
  },
  activeItem: { backgroundColor: colors.selected },
  hoveredItem: { backgroundColor: "#242424" },
  itemCopy: { flex: 1, minWidth: 0, gap: 2 },
  itemTitleRow: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
  itemTitle: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 19, fontWeight: "500" },
  itemPreview: { color: colors.muted, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 12, lineHeight: 16, fontWeight: "400" },
  menuButton: { width: 32, height: 32, flexShrink: 0, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  menuButtonHovered: { backgroundColor: "#2A2A2A" },
  itemMenu: {
    position: "absolute",
    top: 36,
    right: 4,
    zIndex: 1,
    width: 168,
    minHeight: 132,
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A3A3A",
    backgroundColor: "#2A2A2A",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
    overflow: "hidden",
  },
  itemMenuUpward: { top: undefined, bottom: 36 },
  menuAction: { minHeight: 40, borderRadius: 6, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  menuActionHovered: { backgroundColor: "#3A3A3A" },
  deleteActionHovered: { backgroundColor: "rgba(239, 68, 68, 0.15)" },
  menuActionText: { color: "#F5F5F5", fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  deleteText: { color: colors.danger },
  profileRow: {
    minHeight: 62,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  profileCopy: { flex: 1, minWidth: 0, gap: 2 },
  profileName: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 19, fontWeight: "600" },
  profileSubtitle: { color: colors.muted, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 12, lineHeight: 16, fontWeight: "400" },
  pressed: { opacity: 0.78 },
  drawerRoot: { flex: 1, width: "100%", height: "100%", flexDirection: "row" },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.58)",
    zIndex: 0,
  },
  mobileDrawer: { width: "86%", maxWidth: 340, height: "100%", zIndex: 1 },
  dialogBackdrop: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  dialog: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    padding: 20,
    gap: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#191E23",
  },
  dialogTitle: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  dialogBody: { color: colors.muted, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 21, fontWeight: "400" },
  renameInput: {
    minHeight: 42,
    color: colors.text,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    fontSize: 14,
    fontWeight: "400",
  },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  secondaryButton: { minHeight: 38, justifyContent: "center", paddingHorizontal: 12 },
  secondaryButtonText: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  primaryButton: {
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  deleteButton: {
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: "#B94444",
  },
  primaryButtonText: { color: colors.white, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 19, fontWeight: "600" },
});

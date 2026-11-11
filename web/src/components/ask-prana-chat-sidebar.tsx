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
import { createPortal } from "react-dom";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "./user-avatar";
import { AskPranaLogo } from "./ask-prana-logo";
import { PranaHeader, PranaHeaderButton } from "./prana-header";
import { PRANA_FONT, prana } from "../constants/prana-theme";
import { useProfile } from "../context/profile-context";
import { useAskPranaChat } from "../context/ask-prana-chat-context";
import type { AskPranaSessionSummary } from "../services/ask-prana-messages";
import { useAskPranaDisplayTranslation } from "../lib/ask-prana-display-translation";

// AskPrana cream / teal theme.
const colors = {
  accent: prana.teal,
  background: prana.sidebar,
  border: "#D4DDC5",
  danger: "#9E4B3D",
  muted: "#7D927F",
  selected: "#DCE9D6",
  activeConversation: "#E0E8D3",
  text: prana.ink,
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
      } as unknown as ViewStyle)
    : null;

function isPressableHovered(state: { pressed: boolean }) {
  // React Native Web supplies `hovered` at runtime, but the native callback
  // type intentionally omits it.
  return (state as { hovered?: boolean }).hovered === true;
}

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
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function ChatHistoryContextMenu({
  pinned,
  onTogglePin,
  onEdit,
  onDelete,
}: ChatHistoryContextMenuProps) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.itemMenuContent}
    >
      <Pressable
        onPress={onTogglePin}
        style={(state) => [
          styles.menuAction,
          isPressableHovered(state) && styles.menuActionHovered,
          state.pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={pinned ? t("askPrana.unpinChat") : t("askPrana.pinChat")}
      >
        <Feather name="bookmark" size={17} color={colors.text} />
        <Text style={styles.menuActionText}>{pinned ? t("askPrana.unpinChat") : t("askPrana.pinChat")}</Text>
      </Pressable>
      <Pressable
        onPress={onEdit}
        style={(state) => [
          styles.menuAction,
          isPressableHovered(state) && styles.menuActionHovered,
          state.pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t("askPrana.edit")}
      >
        <Feather name="edit-2" size={17} color={colors.text} />
        <Text style={styles.menuActionText}>{t("askPrana.edit")}</Text>
      </Pressable>
      <Pressable
        onPress={onDelete}
        style={(state) => [
          styles.menuAction,
          isPressableHovered(state) && styles.deleteActionHovered,
          state.pressed && styles.pressed,
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
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] =
    useState<AskPranaSessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingSession, setDeletingSession] =
    useState<AskPranaSessionSummary | null>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>([]);
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const historyRequestIdRef = useRef(0);
  const historyInflightRef = useRef<Promise<void> | null>(null);
  const menuTriggerRefs = useRef<Record<string, View | null>>({});
  const normalizedSearch = searchText.trim().toLocaleLowerCase();

  const closeContextMenu = useCallback((restoreFocus = false) => {
    const trigger = menuSessionId ? menuTriggerRefs.current[menuSessionId] : null;
    setMenuSessionId(null);
    setMenuSource(null);
    setMenuPosition(null);
    if (restoreFocus && Platform.OS === "web") {
      setTimeout(() => {
        (trigger as unknown as { focus?: () => void } | null)?.focus?.();
      }, 0);
    }
  }, [menuSessionId]);

  const openContextMenu = useCallback((sessionId: string, source: "pinned" | "history") => {
    if (menuSessionId === sessionId && menuSource === source) {
      closeContextMenu(true);
      return;
    }

    setMenuSessionId(sessionId);
    setMenuSource(source);
    setMenuPosition(null);

    const placeMenu = () => {
      const trigger = menuTriggerRefs.current[sessionId];
      trigger?.measureInWindow?.((x, y, width, height) => {
        const menuWidth = 176;
        const menuHeight = 144;
        const gutter = 8;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const right = x + width + gutter;
        const left = right + menuWidth <= viewportWidth - gutter
          ? right
          : Math.max(gutter, x - menuWidth - gutter);
        const top = y + menuHeight <= viewportHeight - gutter
          ? y
          : Math.max(gutter, y + height - menuHeight);
        setMenuPosition({ left, top });
      });
    };

    if (Platform.OS === "web") {
      window.requestAnimationFrame(placeMenu);
    }
  }, [closeContextMenu, menuSessionId, menuSource]);

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
      closeContextMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu(true);
    };
    const closeOnPointerDown = (event: Event) => {
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
    // `pointerdown` covers mouse, touch, and pen. A `mousedown` listener
    // misses/treats Android browser taps inconsistently after the menu opens.
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [closeContextMenu, menuSessionId]);

  useEffect(() => {
    if (!visible) closeContextMenu();
  }, [closeContextMenu, visible]);

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

  // Translate the newest history entries first. Older sessions continue in
  // the background, so changing language does not make a long chat history
  // compete with the conversation currently on screen.
  const { displayText, getStatus } = useAskPranaDisplayTranslation(
    sessions.flatMap((session) => [session.title, session.preview].filter(Boolean)),
    "visible",
    // Keep room for the open conversation's newest messages. Remaining
    // history rows still translate in the shared background queue. Other
    // languages come from the server's stored translations, not prefetch.
    { priorityCount: 10, prefetchOtherLanguages: false },
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
    closeContextMenu();
    // Close the drawer first: the chat then shows its loader (or the cached
    // messages) at once. Waiting for the download before closing made a tap
    // look like it did nothing for several seconds.
    if (!isDesktop) onClose();
    await openConversation(sessionId);
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
    closeContextMenu();
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
    closeContextMenu();
  };

  const menuSession = menuSessionId
    ? sessions.find((session) => session.id === menuSessionId) ?? null
    : null;
  const floatingMenu = menuSession && menuPosition ? (
    <View
      nativeID="ask-prana-chat-history-menu"
      style={[
        styles.itemMenu,
        {
          position: "fixed",
          left: menuPosition.left,
          top: menuPosition.top,
          right: undefined,
          bottom: undefined,
          zIndex: 1000,
        } as unknown as ViewStyle,
      ]}
    >
      <ChatHistoryContextMenu
        pinned={pinnedSessionIds.includes(menuSession.id)}
        onTogglePin={() => togglePinned(menuSession.id)}
        onEdit={() => {
          setRenamingSession(menuSession);
          setRenameValue(getStatus(menuSession.title) === "ready" ? displayText(menuSession.title) : "");
          closeContextMenu();
        }}
        onDelete={() => {
          setDeletingSession(menuSession);
          closeContextMenu();
        }}
      />
    </View>
  ) : null;

  const content = (
    <View style={[styles.sidebar, isDesktop ? styles.desktopSidebar : styles.mobileSidebar]}>
      {isDesktop ? (
      <View style={styles.topArea}>
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <AskPranaLogo size={31} decorative />
            <Text style={styles.brand}>AskPrana</Text>
          </View>
          <Pressable
            onPress={onClose}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={t("askPrana.collapseSidebar")}
          >
            <Feather name="sidebar" size={18} color="#82927E" />
          </Pressable>
        </View>
        <Pressable
          onPress={() => void startNewChat()}
          style={({ pressed }) => [styles.newChatButton, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Feather name="plus" size={16} color="#235B4B" />
          <Text style={styles.newChatText}>{t("askPrana.newChatShort")}</Text>
        </Pressable>
        <View style={styles.searchBox}>
          <Feather name="search" size={15} color="#7D927F" />
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder={t("askPrana.searchChats")}
            placeholderTextColor="#829481"
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
        <Text style={styles.sidebarLabel}>{t("askPrana.yourConversations")}</Text>
      </View>
      ) : (
      <View style={styles.mobileTop}>
        <Pressable
          onPress={onClose}
          style={styles.backLink}
          accessibilityRole="button"
          accessibilityLabel={t("askPrana.closeHistory")}
        >
          <Feather name="arrow-left" size={13} color="#217C73" />
          <Text style={styles.backLinkText}>{t("askPrana.backToChat")}</Text>
        </Pressable>
        <Text style={styles.kicker}>ASKPRANA</Text>
        <Text style={styles.mobileTitle}>{t("askPrana.historyTitle")}</Text>
        <Text style={styles.mobileSubtitle}>{t("askPrana.historySubtitle")}</Text>
        <View style={[styles.searchBox, styles.searchBoxMobile]}>
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder={t("askPrana.searchConversations")}
            placeholderTextColor="#8A9B8B"
            style={[styles.searchInput, styles.searchInputMobile]}
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
        <Pressable
          onPress={() => void startNewChat()}
          style={({ pressed }) => [styles.newChatMobile, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Feather name="plus" size={15} color="#286C62" />
          <Text style={styles.newChatMobileText}>{t("askPrana.newChatShort")}</Text>
        </Pressable>
      </View>
      )}

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
              {pinnedSessions.map((session) => {
                const showMenuButton =
                  !isDesktop ||
                  hoveredSessionId === session.id ||
                  focusedSessionId === session.id ||
                  (menuSessionId === session.id && menuSource === "pinned");
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
                  onHoverIn={() => setHoveredSessionId(session.id)}
                  onHoverOut={() => setHoveredSessionId((current) => current === session.id ? null : current)}
                  style={(state) => [
                    styles.conversationItem,
                    isPressableHovered(state) && styles.hoveredItem,
                    // After hover so the selected chat stays marked under the cursor.
                    session.id === activeSessionId && styles.activeItem,
                    state.pressed && styles.pressed,
                  ]}
                  accessibilityState={{ selected: session.id === activeSessionId }}
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
                  ref={(node) => { menuTriggerRefs.current[session.id] = node; }}
                  onPress={() => openContextMenu(session.id, "pinned")}
                  onHoverIn={() => setHoveredSessionId(session.id)}
                  onFocus={() => setFocusedSessionId(session.id)}
                  onBlur={() => setFocusedSessionId((current) => current === session.id ? null : current)}
                  style={(state) => [
                    styles.menuButton,
                    !showMenuButton && styles.menuButtonHidden,
                    isPressableHovered(state) && styles.menuButtonHovered,
                    state.pressed && styles.pressed,
                  ]}
                  hitSlop={6}
                  nativeID={`ask-prana-menu-trigger-${session.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: menuSessionId === session.id && menuSource === "pinned" }}
                  accessibilityLabel={t("askPrana.conversationOptions", { title: displayText(session.title) })}
                >
                  <Feather name="more-horizontal" size={17} color={colors.muted} />
                </Pressable>
                </View>
                );
              })}
            </View>
          ) : null}
          {groupedSessions.map((group) => (
            <View key={group.label} style={styles.group}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              {group.items.map((session) => {
                const showMenuButton =
                  !isDesktop ||
                  hoveredSessionId === session.id ||
                  focusedSessionId === session.id ||
                  (menuSessionId === session.id && menuSource === "history");
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
                  onHoverIn={() => setHoveredSessionId(session.id)}
                  onHoverOut={() => setHoveredSessionId((current) => current === session.id ? null : current)}
                    style={({ pressed }) => [
                      styles.conversationItem,
                      hoveredSessionId === session.id && styles.hoveredItem,
                      // After hover so the selected chat stays marked under the cursor.
                      session.id === activeSessionId && styles.activeItem,
                      pressed && styles.pressed,
                    ]}
                    accessibilityState={{ selected: session.id === activeSessionId }}
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
                    ref={(node) => { menuTriggerRefs.current[session.id] = node; }}
                    onPress={() => openContextMenu(session.id, "history")}
                    onHoverIn={() => setHoveredSessionId(session.id)}
                    onFocus={() => setFocusedSessionId(session.id)}
                    onBlur={() => setFocusedSessionId((current) => current === session.id ? null : current)}
                    style={(state) => [
                      styles.menuButton,
                      !showMenuButton && styles.menuButtonHidden,
                      isPressableHovered(state) && styles.menuButtonHovered,
                      state.pressed && styles.pressed,
                    ]}
                    hitSlop={6}
                    nativeID={`ask-prana-menu-trigger-${session.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: menuSessionId === session.id && menuSource === "history" }}
                    accessibilityLabel={t("askPrana.conversationOptions", { title: displayText(session.title) })}
                  >
                    <Feather name="more-horizontal" size={17} color={colors.muted} />
                  </Pressable>
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
            <View style={styles.mobileDrawer}>
              <PranaHeader
                variant="wave"
                left={
                  <PranaHeaderButton
                    icon="message-square"
                    onPress={onClose}
                    label={t("askPrana.closeHistory")}
                  />
                }
                right={<View style={{ width: 42 }} />}
              />
              {content}
            </View>
            {floatingMenu}
          </View>
        </Modal>
      )}

      {isDesktop && Platform.OS === "web" && typeof document !== "undefined"
        ? createPortal(floatingMenu, document.body)
        : null}

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
  },
  desktopSidebar: {
    width: 264,
    minWidth: 264,
    maxWidth: 264,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 264,
    height: "100%",
    borderRightWidth: 1,
    borderRightColor: prana.sidebarBorder,
    paddingTop: 29,
    paddingHorizontal: 19,
    paddingBottom: 19,
  },
  topArea: { gap: 0 },
  brandRow: {
    paddingHorizontal: 7,
    paddingBottom: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandMark: { flexDirection: "row", alignItems: "center", gap: 9 },
  brand: { color: prana.ink, fontFamily: PRANA_FONT, fontSize: 24, lineHeight: 29, fontWeight: "800", letterSpacing: -0.4 },
  iconButton: { width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  newChatButton: {
    minHeight: 49,
    paddingHorizontal: 15,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: "#DCE9D6",
    borderWidth: 1,
    borderColor: "#8EB49E",
    borderRadius: 12,
  },
  newChatText: { color: "#235B4B", fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 18, fontWeight: "700" },
  searchBox: {
    minHeight: 42,
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1,
    borderColor: "#CBD5BF",
    backgroundColor: "#F8F8E9",
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: "#255E50",
    fontFamily: PRANA_FONT,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "400",
    paddingVertical: 8,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : null),
  },
  historyList: { flex: 1, marginTop: 8, overflow: "visible" },
  historyContent: { paddingBottom: 16, gap: 16, overflow: "visible" },
  loadingState: { paddingVertical: 24, alignItems: "center" },
  emptyText: { color: "#6D8976", fontFamily: PRANA_FONT, fontSize: 11, paddingVertical: 18, paddingHorizontal: 9, lineHeight: 20, fontWeight: "400" },
  group: { gap: 3, overflow: "visible" },
  groupLabel: {
    color: "#94A08A",
    fontFamily: PRANA_FONT,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: "800",
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 4,
    paddingHorizontal: 9,
  },
  itemWrap: { position: "relative", flexDirection: "row", alignItems: "center", overflow: "visible", zIndex: 0 },
  itemWrapMenuOpen: { zIndex: 10 },
  conversationItem: {
    minHeight: 44,
    flex: 1,
    minWidth: 0,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 11,
    justifyContent: "center",
    ...(Platform.OS === "web"
      ? ({ transitionProperty: "background-color", transitionDuration: "180ms" } as object)
      : null),
  },
  activeItem: { backgroundColor: colors.activeConversation },
  hoveredItem: { backgroundColor: "#E1E8D5" },
  itemCopy: { flex: 1, minWidth: 0, gap: 2 },
  itemTitleRow: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
  itemTitle: { color: "#245C50", fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 17, fontWeight: "600", flexShrink: 1 },
  itemPreview: { color: "#8C9B85", fontFamily: PRANA_FONT, fontSize: 10, lineHeight: 14, fontWeight: "400" },
  menuButton: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web"
      ? ({ transitionProperty: "opacity, background-color", transitionDuration: "180ms" } as object)
      : null),
  },
  menuButtonHidden: { opacity: 0 },
  menuButtonHovered: { backgroundColor: "#E1E8D5" },
  itemMenu: {
    position: "absolute",
    top: 36,
    right: 4,
    zIndex: 1,
  },
  itemMenuContent: {
    width: 180,
    minHeight: 132,
    padding: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#B5CBB3",
    backgroundColor: prana.card,
    shadowColor: "#1D4B36",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.13,
    shadowRadius: 20,
    elevation: 8,
    overflow: "hidden",
  },
  itemMenuUpward: { top: undefined, bottom: 36 },
  menuAction: { minHeight: 40, borderRadius: 6, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  menuActionHovered: { backgroundColor: prana.attachBg },
  deleteActionHovered: { backgroundColor: "rgba(158, 75, 61, 0.1)" },
  menuActionText: { color: "#225E50", fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  deleteText: { color: colors.danger },
  profileRow: {
    minHeight: 62,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  profileCopy: { flex: 1, minWidth: 0, gap: 2 },
  profileName: { color: "#2F5D4C", fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  profileSubtitle: { color: "#829480", fontFamily: PRANA_FONT, fontSize: 10, lineHeight: 14, fontWeight: "400" },
  pressed: { opacity: 0.78 },
  drawerRoot: { flex: 1, width: "100%", height: "100%", flexDirection: "row", backgroundColor: prana.cream },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: prana.cream,
    zIndex: 0,
  },
  mobileDrawer: { width: "100%", height: "100%", zIndex: 1, backgroundColor: prana.cream },
  dialogBackdrop: { flex: 1, justifyContent: "center", paddingHorizontal: 24, backgroundColor: "rgba(21,57,58,0.4)" },
  dialog: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    padding: 20,
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: prana.line,
    backgroundColor: prana.card,
  },
  dialogTitle: { color: prana.ink, fontFamily: PRANA_FONT, fontSize: 17, lineHeight: 22, fontWeight: "800" },
  dialogBody: { color: prana.muted, fontFamily: PRANA_FONT, fontSize: 14, lineHeight: 21, fontWeight: "400" },
  renameInput: {
    minHeight: 46,
    color: prana.ink,
    fontFamily: PRANA_FONT,
    borderRadius: 11,
    borderWidth: 1.4,
    borderColor: prana.inputBorder,
    backgroundColor: prana.card,
    paddingHorizontal: 12,
    fontSize: 16,
    fontWeight: "400",
  },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  secondaryButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: "#B9CEBC" },
  secondaryButtonText: { color: "#286C62", fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 18, fontWeight: "700" },
  primaryButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 16, borderRadius: 10, backgroundColor: prana.teal },
  deleteButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 16, borderRadius: 10, backgroundColor: "#9E4B3D" },
  primaryButtonText: { color: colors.white, fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 18, fontWeight: "800" },
  mobileSidebar: {
    backgroundColor: prana.cream,
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  searchBoxMobile: {
    minHeight: 51,
    marginTop: 0,
    borderWidth: 1.4,
    borderColor: prana.inputBorder,
    backgroundColor: prana.card,
    borderRadius: 11,
  },
  searchInputMobile: { color: prana.ink, fontSize: 16, lineHeight: 21 },
  sidebarLabel: {
    color: "#94A08A",
    fontFamily: PRANA_FONT,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: 29,
    marginBottom: 4,
    marginHorizontal: 9,
  },
  mobileTop: { paddingTop: 8 },
  backLink: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", minHeight: 40, paddingRight: 8, marginBottom: 6 },
  backLinkText: { color: "#217C73", fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  kicker: { color: prana.tealText, fontFamily: PRANA_FONT, fontSize: 10, lineHeight: 13, fontWeight: "800", letterSpacing: 1.1, marginBottom: 8 },
  mobileTitle: { color: prana.ink, fontFamily: PRANA_FONT, fontSize: 29, lineHeight: 34, fontWeight: "800", marginBottom: 12 },
  mobileSubtitle: { color: prana.muted, fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 21, marginBottom: 27 },
  newChatMobile: {
    minHeight: 48,
    marginTop: 13,
    marginBottom: 5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#B9CEBC",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  newChatMobileText: { color: "#286C62", fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, fontWeight: "700" },
});

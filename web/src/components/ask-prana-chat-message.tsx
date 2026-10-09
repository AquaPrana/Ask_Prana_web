import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Dimensions,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { AskPranaLogo } from "./ask-prana-logo";
import type {
  AskPranaThinkingKind,
  ChatMessage,
} from "../context/ask-prana-chat-context";
import { getAskPranaFileUrl } from "../lib/ask-prana-files";
import { ASK_PRANA_FONT_FAMILY } from "../constants/ask-prana-typography";

const colors = {
  primary: "#4F8CF7",
  white: "#F4F7FA",
  text: "#E6ECF5",
  textDark: "#EDF2F8",
  muted: "#9AA4B2",
  border: "#2A303C",
  bubble: "#1B2330",
  shadow: "#0B1017",
  primarySoft: "#DCEBFF",
  tableHeader: "#1D2531",
  tableBorder: "#2D3746",
  viewerBg: "#0B0F15",
};

const SCREEN = Dimensions.get("window");

/* eslint-disable react-hooks/immutability -- Reanimated shared values are intentionally mutated inside gesture worklets. */
function ZoomableAttachmentImage({
  uri,
  title,
  visible,
  onError,
}: {
  uri: string;
  title: string;
  visible: boolean;
  onError: () => void;
}) {
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      scale.value = withTiming(1, { duration: 180 });
      translateX.value = withTiming(0, { duration: 180 });
      translateY.value = withTiming(0, { duration: 180 });
    }
  }, [scale, translateX, translateY, visible]);

  const gesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Pinch()
          .onBegin(() => {
            startScale.value = scale.value;
          })
          .onUpdate((event) => {
            scale.value = Math.max(1, Math.min(startScale.value * event.scale, 4));
          })
          .onEnd(() => {
            if (scale.value <= 1.02) {
              scale.value = withTiming(1, { duration: 160 });
              translateX.value = withTiming(0, { duration: 160 });
              translateY.value = withTiming(0, { duration: 160 });
            }
          }),
        Gesture.Pan()
          .onBegin(() => {
            startX.value = translateX.value;
            startY.value = translateY.value;
          })
          .onUpdate((event) => {
            if (scale.value > 1) {
              translateX.value = startX.value + event.translationX;
              translateY.value = startY.value + event.translationY;
            }
          }),
      ),
    [scale, startScale, startX, startY, translateX, translateY],
  );
  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // ScrollView gives Safari/iOS Web the expected native zoom behaviour; the
  // gesture implementation covers Android and iOS app builds.
  if (Platform.OS === "web") {
    return (
      <ScrollView
        style={styles.imageViewerScroll}
        contentContainerStyle={styles.imageViewerScrollContent}
        maximumZoomScale={4}
        minimumZoomScale={1}
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      >
        <Image source={{ uri }} style={styles.imageViewerImage} contentFit="contain" accessibilityLabel={`Full size ${title}`} onError={onError} />
      </ScrollView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.imageViewerScroll}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={styles.imageViewerScrollContent}>
          <Animated.View style={imageStyle}>
            <Image source={{ uri }} style={styles.imageViewerImage} contentFit="contain" accessibilityLabel={`Full size ${title}`} onError={onError} />
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}
/* eslint-enable react-hooks/immutability */

/** Normalize fancy pipes / dashes the model sometimes emits. */
function normalizeTableSource(text: string): string {
  return String(text ?? "")
    .replace(/\uFF5C/g, "|") // fullwidth vertical line
    .replace(/\u2502/g, "|") // box drawings light vertical
    .replace(/\u2503/g, "|")
    .replace(/\u01C0/g, "|")
    .replace(/\u2013/g, "-") // en dash
    .replace(/\u2014/g, "-") // em dash
    .replace(/\u2212/g, "-") // minus
    .replace(/\u00A0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function isMarkdownTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  // Mostly dashes/colons/pipes/spaces (header underline)
  const stripped = t.replace(/[\s|:\-]+/g, "");
  return stripped.length === 0 && /[-:]/.test(t);
}

/** Split a pipe-table row into cells. Returns null if the line is not tabular. */
function splitPipeTableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.includes("|")) return null;
  if (isMarkdownTableSeparator(t)) return null;

  let cells = t.split("|").map((cell) => cell.trim());
  if (t.startsWith("|")) cells = cells.slice(1);
  if (t.endsWith("|")) cells = cells.slice(0, -1);
  while (cells.length > 0 && cells[cells.length - 1] === "") {
    cells = cells.slice(0, -1);
  }
  if (cells.length < 2) return null;
  return cells;
}

type FormattedBlock =
  | { kind: "table"; rows: string[][] }
  | { kind: "line"; line: string; index: number };

function buildFormattedBlocks(text: string): FormattedBlock[] {
  const lines = normalizeTableSource(text).split("\n");
  const blocks: FormattedBlock[] = [];
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    // Drop pure-separator-looking body rows that slipped through
    const cleaned = tableRows.filter((row) => {
      const joined = row.join("").replace(/[\s\-:/]+/g, "");
      return joined.length > 0;
    });
    if (cleaned.length === 0) {
      tableRows = [];
      return;
    }
    blocks.push({ kind: "table", rows: cleaned });
    tableRows = [];
  };

  lines.forEach((line, index) => {
    if (isMarkdownTableSeparator(line)) {
      return;
    }
    const cells = splitPipeTableCells(line);
    if (cells) {
      tableRows.push(cells);
      return;
    }
    // Continuation of a wrapped table cell (no pipe on this line)
    if (tableRows.length > 0 && line.trim()) {
      const last = tableRows[tableRows.length - 1]!;
      const lastIdx = last.length - 1;
      last[lastIdx] = `${last[lastIdx] ?? ""} ${line.trim()}`.trim();
      return;
    }
    flushTable();
    blocks.push({ kind: "line", line, index });
  });
  flushTable();
  return blocks;
}

function AskPranaChatTable({ rows }: { rows: string[][] }) {
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const next = [...row];
    while (next.length < colCount) next.push("");
    return next.slice(0, colCount);
  });
  const headers = normalized[0] ?? [];
  const bodyRows =
    normalized.length > 1
      ? normalized.slice(1)
      : normalized.length === 1
        ? []
        : [];

  // Prefer labeled cards whenever we have a header + body (mobile-friendly "table").
  if (headers.length >= 2 && bodyRows.length > 0) {
    return (
      <View style={styles.tableCardStack}>
        {bodyRows.map((row, rowIndex) => (
          <View key={`card-${rowIndex}`} style={styles.tableCard}>
            {row.map((cell, colIndex) => {
              const label = headers[colIndex]?.trim() || `Column ${colIndex + 1}`;
              const isTitle = colIndex === 0;
              return (
                <View
                  key={`card-${rowIndex}-${colIndex}`}
                  style={[
                    styles.tableCardField,
                    isTitle && styles.tableCardFieldTitle,
                    colIndex === row.length - 1 && styles.tableCardFieldLast,
                  ]}
                >
                  <Text style={styles.tableCardLabel}>{label}</Text>
                  <Text
                    style={[
                      styles.tableCardValue,
                      isTitle && styles.tableCardTitle,
                    ]}
                  >
                    {cell?.trim() || "—"}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  }

  // Fallback grid for tiny tables / header-only
  const cellMinWidth = colCount === 3 ? 112 : 130;
  return (
    <View style={styles.tableWrap}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={styles.tableScroll}
        contentContainerStyle={styles.tableScrollContent}
      >
        <View style={styles.table}>
          {normalized.map((row, rowIndex) => {
            const isHeader = rowIndex === 0;
            return (
              <View
                key={`tr-${rowIndex}`}
                style={[
                  styles.tableRow,
                  isHeader && styles.tableHeaderRow,
                  rowIndex === normalized.length - 1 && styles.tableRowLast,
                ]}
              >
                {row.map((cell, colIndex) => (
                  <View
                    key={`td-${rowIndex}-${colIndex}`}
                    style={[
                      styles.tableCell,
                      { minWidth: cellMinWidth, width: cellMinWidth + 48 },
                      colIndex === row.length - 1 && styles.tableCellLast,
                      isHeader && styles.tableHeaderCell,
                    ]}
                  >
                    <Text
                      style={[
                        styles.tableCellText,
                        isHeader && styles.tableHeaderText,
                      ]}
                    >
                      {cell || "—"}
                    </Text>
                  </View>
                ))}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function AskPranaFormattedText({
  text,
  color,
}: {
  text: string;
  color: string;
}) {
  const source = String(text ?? "");
  let blocks: FormattedBlock[] = [];
  try {
    blocks = buildFormattedBlocks(source);
  } catch {
    blocks = [{ kind: "line", line: source, index: 0 }];
  }

  // If the model returned pipes but parsing failed, still try one whole-table pass.
  const pipeCount = (source.match(/\|/g) || []).length;
  const hasTableBlock = blocks.some((b) => b.kind === "table");
  if (!hasTableBlock && pipeCount >= 3) {
    const forced: string[][] = [];
    for (const line of normalizeTableSource(source).split("\n")) {
      if (isMarkdownTableSeparator(line)) continue;
      const cells = splitPipeTableCells(line);
      if (cells && cells.length >= 2) forced.push(cells);
    }
    if (forced.length >= 2) {
      blocks = [{ kind: "table", rows: forced }];
    }
  }

  return (
    <View style={{ gap: 8, width: "100%" }}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === "table") {
          return (
            <AskPranaChatTable
              key={`table-${blockIndex}-${block.rows.length}`}
              rows={block.rows}
            />
          );
        }

        const { line, index } = block;
        const heading = line.match(/^#{1,3}\s+(.*)$/);
        const bullet = line.match(/^\s*(?:[-*•]|\u2022)\s+(.*)$/);
        const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        const checklist = line.match(
          /^\s*(?:-\s*)?(?:\[[ xX]?\]|□|☐|☑)\s*(.*)$/,
        );

        if (heading) {
          return (
            <Text
              key={`${index}-h-${heading[1].slice(0, 12)}`}
              style={[
                styles.assistantBubbleText,
                { color },
                styles.assistantHeading,
              ]}
            >
              {renderInlineMarkdown(heading[1], color, true)}
            </Text>
          );
        }

        if (checklist) {
          return (
            <View key={`${index}-c`} style={styles.listRow}>
              <Text style={[styles.listMarker, { color }]}>□</Text>
              <Text
                style={[styles.assistantBubbleText, styles.listText, { color }]}
              >
                {renderInlineMarkdown(checklist[1], color, false)}
              </Text>
            </View>
          );
        }

        if (bullet) {
          return (
            <View key={`${index}-b`} style={styles.listRow}>
              <Text style={[styles.listMarker, { color }]}>•</Text>
              <Text
                style={[styles.assistantBubbleText, styles.listText, { color }]}
              >
                {renderInlineMarkdown(bullet[1], color, false)}
              </Text>
            </View>
          );
        }

        if (numbered) {
          return (
            <View key={`${index}-n`} style={styles.listRow}>
              <Text style={[styles.listMarker, { color }]}>{numbered[1]}.</Text>
              <Text
                style={[styles.assistantBubbleText, styles.listText, { color }]}
              >
                {renderInlineMarkdown(numbered[2], color, false)}
              </Text>
            </View>
          );
        }

        if (!line.trim()) {
          return <View key={`${index}-sp`} style={{ height: 4 }} />;
        }

        return (
          <Text
            key={`${index}-${line.slice(0, 12)}`}
            style={[styles.assistantBubbleText, { color }]}
          >
            {renderInlineMarkdown(line, color, false)}
          </Text>
        );
      })}
    </View>
  );
}

function renderInlineMarkdown(text: string, color: string, heading: boolean) {
  const parts = text.split(/(\*\*[^*]+?\*\*)/g);
  return parts.map((part, index) => {
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      return (
        <Text
          key={`${index}-${bold[1]}`}
          style={{
            color,
            fontFamily: ASK_PRANA_FONT_FAMILY,
            fontWeight: "700",
          }}
        >
          {bold[1]}
        </Text>
      );
    }
    return (
      <Text
        key={`${index}-${part.slice(0, 8)}`}
        style={{
          color,
          fontFamily: ASK_PRANA_FONT_FAMILY,
          fontWeight: heading ? "600" : "400",
        }}
      >
        {part}
      </Text>
    );
  });
}

export function AskPranaAttachmentViewer({
  uri,
  fileName,
  mimeType,
  visible,
  onClose,
}: {
  uri: string | null | undefined;
  fileName?: string | null;
  mimeType?: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [imageFailed, setImageFailed] = useState(false);
  const isImage =
    mimeType?.startsWith("image/") ||
    /\.(jpe?g|png|webp|gif)$/i.test(fileName ?? uri ?? "");
  const title = fileName?.trim() || (isImage ? "Image" : "Document");

  const openExternally = async () => {
    if (!uri) return;
    try {
      await Linking.openURL(uri);
    } catch {
      Alert.alert("Preview unavailable", "Unable to open this document right now.");
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.imageViewerRoot, { paddingTop: insets.top + 8 }]}>
        <View style={styles.imageViewerHeader}>
          <Text style={styles.imageViewerTitle} numberOfLines={1}>{title}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={styles.imageViewerCloseBtn}
            accessibilityRole="button"
            accessibilityLabel="Close image"
          >
            <Feather name="x" size={22} color={colors.white} />
          </Pressable>
        </View>
        {isImage && uri && !imageFailed ? (
          <ZoomableAttachmentImage
            uri={uri}
            title={title}
            visible={visible}
            onError={() => setImageFailed(true)}
          />
        ) : isImage ? <View style={styles.documentViewerContent}>
          <View style={styles.documentViewerIcon}>
            <Feather name="image" size={34} color={colors.primary} />
          </View>
          <Text style={styles.documentViewerName}>Unable to load this image</Text>
          <Pressable
            onPress={() => setImageFailed(false)}
            style={styles.documentViewerOpenButton}
            accessibilityRole="button"
            accessibilityLabel="Retry loading image"
          >
            <Feather name="refresh-cw" size={16} color={colors.white} />
            <Text style={styles.documentViewerOpenText}>Retry</Text>
          </Pressable>
        </View> : <View style={styles.documentViewerContent}>
          <View style={styles.documentViewerIcon}>
            <Feather name="file-text" size={34} color={colors.primary} />
          </View>
          <Text style={styles.documentViewerName} numberOfLines={2}>{title}</Text>
          <Text style={styles.documentViewerMeta}>
            {mimeType?.includes("pdf") ? "PDF document" : "Document preview is not available in the app"}
          </Text>
          <Pressable
            onPress={() => void openExternally()}
            style={styles.documentViewerOpenButton}
            disabled={!uri}
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
          >
            <Feather name="external-link" size={16} color={colors.white} />
            <Text style={styles.documentViewerOpenText}>Open document</Text>
          </Pressable>
        </View>}
        <Text
          style={[
            styles.imageViewerHint,
            { paddingBottom: Math.max(insets.bottom, 12) },
          ]}
        >
          Pinch to zoom · Tap X to close
        </Text>
      </View>
    </Modal>
  );
}

function UserAttachmentContent({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const [viewerOpen, setViewerOpen] = useState(false);
  const [documentViewerOpen, setDocumentViewerOpen] = useState(false);
  const imageUri = message.localUri ?? message.fileUrl;
  const isImage =
    message.messageType === "image" ||
    message.mimeType?.startsWith("image/") === true;

  if (isImage && imageUri) {
    return (
      <View style={styles.attachmentBlock}>
        <Pressable
          onPress={() => setViewerOpen(true)}
          accessibilityRole="imagebutton"
          accessibilityLabel="View image full size"
        >
          <Image
            source={{ uri: imageUri }}
            style={styles.imagePreview}
            contentFit="cover"
          />
          <View style={styles.imageExpandBadge} pointerEvents="none">
            <Feather name="maximize-2" size={14} color={colors.white} />
          </View>
        </Pressable>
        {message.text?.trim() ? (
          <Text style={styles.userBubbleText}>{message.text.trim()}</Text>
        ) : null}
        <AskPranaAttachmentViewer
          uri={imageUri}
          fileName={message.fileName}
          mimeType={message.mimeType}
          visible={viewerOpen}
          onClose={() => setViewerOpen(false)}
        />
      </View>
    );
  }

  if (isImage) {
    return (
      <View style={styles.imagePlaceholder}>
        <Feather name="image" size={24} color={colors.white} />
        <Text style={styles.imagePlaceholderText}>
          {message.fileName ?? "Image"}
        </Text>
      </View>
    );
  }

  if (message.messageType === "document") {
    const openUri = message.fileUrl ?? message.localUri;
    return (
      <>
        <Pressable
          onPress={() => setDocumentViewerOpen(true)}
          style={styles.documentBubble}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${message.fileName ?? t("askPrana.document")}`}
        >
          <View style={styles.documentIcon}>
            <Feather name="file-text" size={18} color={colors.primary} />
          </View>
          <View style={styles.documentCopy}>
            <Text style={styles.documentName} numberOfLines={2}>
              {message.fileName ?? t("askPrana.document")}
            </Text>
            {message.text?.trim() ? (
              <Text style={styles.userBubbleText}>{message.text.trim()}</Text>
            ) : (
              <Text style={styles.documentMeta}>{t("askPrana.tapToOpen")}</Text>
            )}
          </View>
        </Pressable>
        <AskPranaAttachmentViewer
          uri={openUri}
          fileName={message.fileName}
          mimeType={message.mimeType}
          visible={documentViewerOpen}
          onClose={() => setDocumentViewerOpen(false)}
        />
      </>
    );
  }

  if (message.messageType === "audio") {
    const heard =
      message.transcript?.trim() ||
      (message.text?.trim() &&
      !message.text.includes("://") &&
      !message.text.startsWith("file:")
        ? message.text.trim()
        : "");
    return (
      <View style={styles.audioBubble}>
        <View style={styles.audioIcon}>
          <Feather name="mic" size={16} color={colors.primary} />
        </View>
        <View style={styles.audioCopy}>
          <Text style={styles.audioLabel}>{t("askPrana.voiceNote")}</Text>
          {heard ? (
            <Text style={styles.userBubbleText}>{heard}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  return <Text style={styles.userBubbleText}>{message.text}</Text>;
}

function getMessagePlainText(message: ChatMessage): string {
  if (message.messageType === "audio") {
    const heard =
      message.transcript?.trim() ||
      (message.text?.trim() &&
      !message.text.includes("://") &&
      !message.text.startsWith("file:")
        ? message.text.trim()
        : "");
    return heard || "";
  }
  return message.text?.trim() || "";
}

  type MessageActionRowProps = {
  align: "left" | "right";
  copyText?: string | null;
  editText?: string | null;
  onEdit?: () => void;
  onReadAloud?: (text: string) => void;
  /** ChatGPT-style assistant extras */
  showAssistantExtras?: boolean;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
};

function MessageActionRow({
  align,
  copyText,
  editText,
  onEdit,
  onReadAloud,
  showAssistantExtras = false,
  onRegenerate,
  regenerateDisabled = false,
}: MessageActionRowProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const canCopy = Boolean(copyText?.trim());
  const canEdit = Boolean(editText?.trim() && onEdit);
  const canRegenerate = Boolean(onRegenerate);

  if (!canCopy && !canEdit && !showAssistantExtras) {
    return null;
  }

  const copyToClipboard = async () => {
    const value = copyText?.trim();
    if (!value) {
      return;
    }
    try {
      await Clipboard.setStringAsync(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      Alert.alert(t("askPrana.copyFailed"), t("askPrana.copyFailedBody"));
    }
  };

  const shareText = async () => {
    const value = copyText?.trim();
    if (!value) {
      Alert.alert(t("askPrana.nothingToShare"), t("askPrana.nothingToShareBody"));
      return;
    }
    try {
      await Share.share({ message: value });
    } catch {
      // User dismissed share sheet — ignore.
    }
  };

  const openMoreMenu = () => {
    const buttons: {
      text: string;
      onPress?: () => void;
      style?: "cancel" | "destructive" | "default";
    }[] = [];

    if (canCopy) {
      buttons.push({
        text: t("askPrana.copy"),
        onPress: () => {
          void copyToClipboard();
        },
      });
      buttons.push({
        text: t("askPrana.share"),
        onPress: () => {
          void shareText();
        },
      });
    }
    buttons.push({ text: t("common.cancel"), style: "cancel" });

    if (buttons.length <= 1) {
      return;
    }
    Alert.alert(t("askPrana.more"), undefined, buttons);
  };

  return (
    <View
      style={[
        styles.actionRow,
        align === "right" ? styles.actionRowRight : styles.actionRowLeft,
      ]}
    >
      {canCopy ? (
          <Pressable
            onPress={() => {
              void copyToClipboard();
            }}
            hitSlop={8}
            style={({ pressed }) => [
              styles.actionButton,
              pressed && styles.actionButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={copied ? t("askPrana.copied") : t("askPrana.copy")}
          >
            <Feather
              name={copied ? "check" : "copy"}
              size={15}
              color={copied ? colors.primary : colors.muted}
            />
          </Pressable>
        ) : null}

      {canEdit ? (
        <Pressable
          onPress={() => onEdit?.()}
          hitSlop={8}
          style={({ pressed }) => [
            styles.actionButton,
            pressed && styles.actionButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("askPrana.edit")}
        >
          <Feather name="edit-2" size={15} color={colors.muted} />
        </Pressable>
      ) : null}

      {canCopy && onReadAloud ? (
        <Pressable
          onPress={() => onReadAloud(copyText!.trim())}
          hitSlop={8}
          style={({ pressed }) => [
            styles.actionButton,
            pressed && styles.actionButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("askPrana.readAloud")}
        >
          <Feather name="volume-2" size={15} color={colors.muted} />
        </Pressable>
      ) : null}

      {showAssistantExtras ? (
        <>
          <Pressable
            onPress={() =>
              setFeedback((current) => (current === "up" ? null : "up"))
            }
            hitSlop={8}
            style={({ pressed }) => [
              styles.actionButton,
              pressed && styles.actionButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("askPrana.like")}
          >
            <Feather
              name="thumbs-up"
              size={15}
              color={feedback === "up" ? colors.primary : colors.muted}
            />
          </Pressable>
          <Pressable
            onPress={() =>
              setFeedback((current) => (current === "down" ? null : "down"))
            }
            hitSlop={8}
            style={({ pressed }) => [
              styles.actionButton,
              pressed && styles.actionButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("askPrana.dislike")}
          >
            <Feather
              name="thumbs-down"
              size={15}
              color={feedback === "down" ? colors.primary : colors.muted}
            />
          </Pressable>
          {canRegenerate ? (
            <Pressable
              onPress={onRegenerate}
              disabled={regenerateDisabled}
              hitSlop={8}
              style={({ pressed }) => [
                styles.actionButton,
                pressed && styles.actionButtonPressed,
                regenerateDisabled && styles.actionButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("askPrana.regenerate")}
            >
              <Feather name="refresh-cw" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
          {canCopy ? (
            <Pressable
              onPress={openMoreMenu}
              hitSlop={8}
              style={({ pressed }) => [
                styles.actionButton,
                pressed && styles.actionButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("askPrana.more")}
            >
              <Feather name="more-horizontal" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function AskPranaChatMessageBubbleComponent({
  message,
  isEditingUserMessage = false,
  onBeginEditUserMessage,
  onCancelEditUserMessage,
  onSubmitEditUserMessage,
  editDisabled = false,
  onRegenerateAssistantMessage,
  regenerateDisabled,
  onReadAloud,
}: {
  message: ChatMessage;
  isEditingUserMessage?: boolean;
  onBeginEditUserMessage?: (messageId: string) => void;
  onCancelEditUserMessage?: () => void;
  onSubmitEditUserMessage?: (messageId: string, text: string) => void;
  editDisabled?: boolean;
  onRegenerateAssistantMessage?: (messageId: string) => void;
  regenerateDisabled?: boolean;
  onReadAloud?: (text: string) => void;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const plainText = getMessagePlainText(message);
  const { height: viewportHeight } = useWindowDimensions();
  const editInputMaxHeight = Math.max(
    120,
    Math.min(300, Math.round(viewportHeight * 0.4)),
  );
  const [editDraft, setEditDraft] = useState(plainText);
  const [editInputHeight, setEditInputHeight] = useState(48);
  const editSubmitLockRef = useRef(false);
  const editInputRef = useRef<TextInput>(null);
  const resizeWebEditInput = useCallback((fallbackHeight?: number) => {
    const textarea = editInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!textarea) {
      if (fallbackHeight != null) {
        setEditInputHeight(
          Math.max(48, Math.min(fallbackHeight, editInputMaxHeight)),
        );
      }
      return;
    }

    textarea.style.maxHeight = "none";
    textarea.style.height = "0px";
    textarea.style.overflowY = "hidden";
    const measuredHeight = textarea.scrollHeight;
    const contentHeight =
      measuredHeight > 0 ? measuredHeight : (fallbackHeight ?? 0);
    const nextHeight = Math.max(
      48,
      Math.min(contentHeight, editInputMaxHeight),
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.maxHeight = `${editInputMaxHeight}px`;
    textarea.style.overflowY =
      contentHeight > editInputMaxHeight ? "auto" : "hidden";
    textarea.style.resize = "none";
    setEditInputHeight((current) =>
      current === nextHeight ? current : nextHeight,
    );
  }, [editInputMaxHeight]);

  useEffect(() => {
    if (!isEditingUserMessage || Platform.OS !== "web") return;
    const frame = requestAnimationFrame(() => resizeWebEditInput());
    return () => cancelAnimationFrame(frame);
  }, [editDraft, isEditingUserMessage, resizeWebEditInput]);
  const isImageOnly =
    isUser &&
    (message.messageType === "image" ||
      message.mimeType?.startsWith("image/") === true) &&
    !message.text?.trim();

  if (isUser) {
    if (isEditingUserMessage) {
      const trimmed = editDraft.trim();
      const canSend = Boolean(trimmed) && !editDisabled;
      const saveEdit = () => {
        if (!canSend || !onSubmitEditUserMessage || editSubmitLockRef.current) return;
        editSubmitLockRef.current = true;
        onSubmitEditUserMessage(message.id, trimmed);
      };
      return (
        <View style={styles.userBubbleWrap}>
          <View style={styles.userEditCard}>
            <TextInput
              ref={editInputRef}
              value={editDraft}
              onChangeText={setEditDraft}
              multiline
              autoFocus
              blurOnSubmit={false}
              submitBehavior="submit"
              returnKeyType="done"
              textAlignVertical="top"
              scrollEnabled={editInputHeight >= editInputMaxHeight}
              onLayout={() => {
                if (Platform.OS === "web") {
                  requestAnimationFrame(() => resizeWebEditInput());
                }
              }}
              onContentSizeChange={(event) => {
                const reportedHeight = event.nativeEvent.contentSize.height + 20;
                if (Platform.OS === "web") {
                  requestAnimationFrame(() =>
                    resizeWebEditInput(reportedHeight),
                  );
                  return;
                }
                setEditInputHeight(
                  Math.max(48, Math.min(reportedHeight, editInputMaxHeight)),
                );
              }}
              onSubmitEditing={Platform.OS === "web" ? undefined : saveEdit}
              onKeyPress={(event) => {
                const keyEvent = event.nativeEvent as typeof event.nativeEvent & {
                  shiftKey?: boolean;
                };
                if (keyEvent.key === "Escape") {
                  event.preventDefault();
                  onCancelEditUserMessage?.();
                  return;
                }
                if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
                  event.preventDefault();
                  saveEdit();
                }
              }}
              style={[
                styles.userEditInput,
                { height: editInputHeight, maxHeight: editInputMaxHeight },
              ]}
              placeholder="Edit your message"
              placeholderTextColor={colors.muted}
            />
            <View style={styles.userEditActions}>
              <Pressable
                onPress={() => onCancelEditUserMessage?.()}
                style={({ pressed }) => [
                  styles.userEditCancelButton,
                  pressed && styles.actionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.userEditCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (!canSend) return;
                  onSubmitEditUserMessage?.(message.id, trimmed);
                }}
                disabled={!canSend}
                style={({ pressed }) => [
                  styles.userEditSendButton,
                  !canSend && styles.userEditSendButtonDisabled,
                  pressed && canSend && styles.actionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Save"
              >
                <Text style={styles.userEditSendText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.userBubbleWrap}>
        <View style={[styles.userBubble, isImageOnly && styles.userImageBubble]}>
          <UserAttachmentContent message={message} />
        </View>
        <MessageActionRow
          align="right"
          copyText={plainText}
          editText={plainText}
          onEdit={
            plainText && onBeginEditUserMessage && !editDisabled
              ? () => onBeginEditUserMessage(message.id)
              : undefined
          }
        />
      </View>
    );
  }

  const isGeneratedDocument =
    message.messageType === "document" &&
    Boolean(message.filePath || message.fileUrl || message.fileName);

  const assistantActions = (
    <MessageActionRow
      align="left"
      copyText={plainText}
      onReadAloud={onReadAloud}
      showAssistantExtras
      onRegenerate={
        onRegenerateAssistantMessage
          ? () => onRegenerateAssistantMessage(message.id)
          : undefined
      }
      regenerateDisabled={regenerateDisabled}
    />
  );

  if (isGeneratedDocument) {
    const openUri = message.fileUrl ?? message.localUri;
    const fileNameLower = (message.fileName ?? "").toLowerCase();
    const mime = (message.mimeType ?? "").toLowerCase();
    const isPdf = mime === "application/pdf" || fileNameLower.endsWith(".pdf");
    const isExcel =
      mime.includes("spreadsheetml") ||
      mime.includes("excel") ||
      fileNameLower.endsWith(".xlsx") ||
      fileNameLower.endsWith(".xls");
    const typeLabel = isPdf
      ? t("askPrana.pdfDocument")
      : isExcel
        ? t("askPrana.excelSpreadsheet")
        : t("askPrana.wordDocument");
    const downloadLabel = isExcel
      ? t("askPrana.downloadExcel", { defaultValue: "Download Excel" })
      : isPdf
        ? t("askPrana.downloadPdf", { defaultValue: "Download PDF" })
        : t("askPrana.downloadWord", {
            defaultValue: "Download Word",
          });

    return (
      <View style={styles.assistantBlock}>
        <AskPranaAssistantIdentity />
        <View style={styles.assistantFileCard}>
          <View style={styles.assistantFileRow}>
            <View
              style={[
                styles.assistantFileIcon,
                isPdf
                  ? styles.assistantFileIconPdf
                  : isExcel
                    ? styles.assistantFileIconExcel
                    : styles.assistantFileIconDocx,
              ]}
            >
              <Feather
                name={isPdf ? "file" : isExcel ? "grid" : "file-text"}
                size={18}
                color={colors.primary}
              />
            </View>
            <View style={styles.assistantFileCopy}>
              <Text style={styles.assistantFileName} numberOfLines={2}>
                {message.fileName ?? t("askPrana.document")}
              </Text>
              <Text style={styles.assistantFileMeta}>{typeLabel}</Text>
            </View>
          </View>
          <Pressable
            onPress={() => {
              void (async () => {
                try {
                  const refreshed = await getAskPranaFileUrl(
                    message.filePath ?? null,
                  );
                  const stored =
                    openUri && !openUri.includes("/aquagpt-files/") ? openUri : null;
                  const target = refreshed ?? stored;
                  if (!target) {
                    Alert.alert(
                      t("askPrana.downloadUnavailable"),
                      t("askPrana.downloadLinkUnavailable"),
                    );
                    return;
                  }
                  await Linking.openURL(target);
                } catch {
                  Alert.alert(
                    t("askPrana.downloadUnavailable"),
                    t("askPrana.downloadOpenUnavailable"),
                  );
                }
              })();
            }}
            style={[
              styles.assistantDownloadButton,
              !openUri && !message.filePath && styles.assistantDownloadButtonDisabled,
            ]}
            disabled={!openUri && !message.filePath}
          >
            <Feather name="download" size={14} color={colors.white} />
            <Text style={styles.assistantDownloadText}>{downloadLabel}</Text>
          </Pressable>
          {message.text?.trim() ? (
            <Text style={styles.assistantFileCaption}>{message.text.trim()}</Text>
          ) : null}
        </View>
        {assistantActions}
      </View>
    );
  }

  return (
    <View style={styles.assistantBlock}>
      <AskPranaAssistantIdentity />
      <View style={styles.assistantBubble}>
        <AskPranaFormattedText text={message.text} color={colors.textDark} />
      </View>
      {assistantActions}
    </View>
  );
}

/** Assistant-only identity row; user messages never render this. */
function AskPranaAssistantIdentity() {
  const { t } = useTranslation();
  return (
    <View style={styles.assistantIdentity}>
      <AskPranaLogo size={24} decorative />
      <Text style={styles.assistantIdentityName}>{t("askPrana.title")}</Text>
    </View>
  );
}

/**
 * Memoized: translation batches landing (or a language switch) re-render only
 * the bubbles whose displayed message object actually changed.
 */
export const AskPranaChatMessageBubble = memo(AskPranaChatMessageBubbleComponent);

function thinkingLabel(kind: AskPranaThinkingKind) {
  if (kind === "image") return "Analyzing image";
  if (kind === "document") return "Analyzing document";
  if (kind === "attachments") return "Analyzing attachments";
  return "Thinking";
}

function AskPranaThinkingDots() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % 3);
    }, 380);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.thinkingDots}>
      {[0, 1, 2].map((index) => (
        <View
          key={index}
          style={[
            styles.thinkingDot,
            index === frame && styles.thinkingDotActive,
          ]}
        />
      ))}
    </View>
  );
}

export function AskPranaThinkingBubble({
  kind,
  label,
}: {
  kind: AskPranaThinkingKind;
  /** Overrides the default label, e.g. while a requested file is generated. */
  label?: string | null;
}) {
  return (
    <View style={styles.assistantBlock}>
      <AskPranaAssistantIdentity />
      <View style={styles.thinkingRow}>
        <Text style={styles.thinkingText}>{label ?? `${thinkingLabel(kind)}...`}</Text>
        <AskPranaThinkingDots />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  assistantBlock: { width: "100%", gap: 6, alignItems: "flex-start" },
  assistantIdentity: { flexDirection: "row", alignItems: "center", gap: 8 },
  assistantTranslating: { color: colors.muted, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  assistantIdentityName: { color: colors.textDark, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  assistantBubble: {
    backgroundColor: "transparent",
    maxWidth: "100%",
    alignSelf: "stretch",
    paddingVertical: 2,
  },
  assistantFileCard: {
    backgroundColor: colors.bubble,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
    maxWidth: "94%",
    gap: 12,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 2,
  },
  assistantFileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  assistantFileIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  assistantFileIconDocx: {
    backgroundColor: "#E8F5F3",
  },
  assistantFileIconExcel: {
    backgroundColor: "#E8F5EC",
  },
  assistantFileIconPdf: {
    backgroundColor: "#F3E8E8",
  },
  assistantFileCopy: { flex: 1, gap: 2 },
  assistantFileName: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  assistantFileMeta: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "400",
  },
  assistantDownloadButton: {
    alignSelf: "stretch",
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  assistantDownloadButtonDisabled: {
    opacity: 0.45,
  },
  assistantDownloadText: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  assistantFileCaption: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "400",
  },
  assistantBubbleText: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "400",
  },
  tableScroll: {
    marginVertical: 2,
    maxWidth: "100%",
  },
  tableScrollContent: {
    paddingRight: 4,
  },
  tableWrap: {
    gap: 4,
    maxWidth: "100%",
  },
  tableHint: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "500",
  },
  tableCardStack: {
    gap: 10,
    maxWidth: "100%",
  },
  tableCard: {
    borderWidth: 1,
    borderColor: colors.tableBorder,
    borderRadius: 12,
    backgroundColor: colors.white,
    overflow: "hidden",
  },
  tableCardField: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.tableBorder,
    gap: 2,
  },
  tableCardFieldTitle: {
    backgroundColor: colors.tableHeader,
  },
  tableCardFieldLast: {
    borderBottomWidth: 0,
  },
  tableCardLabel: {
    color: colors.primary,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  tableCardValue: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "400",
  },
  tableCardTitle: {
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontWeight: "600",
    fontSize: 14,
    lineHeight: 20,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.tableBorder,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: colors.white,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.tableBorder,
  },
  tableRowLast: {
    borderBottomWidth: 0,
  },
  tableHeaderRow: {
    backgroundColor: colors.tableHeader,
  },
  tableCell: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.tableBorder,
    paddingHorizontal: 8,
    paddingVertical: 8,
    justifyContent: "flex-start",
  },
  tableCellLast: {
    borderRightWidth: 0,
  },
  tableHeaderCell: {
    backgroundColor: colors.tableHeader,
  },
  tableCellText: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "400",
  },
  tableHeaderText: {
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontWeight: "600",
    color: colors.primary,
    fontSize: 11,
    lineHeight: 15,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingRight: 4,
  },
  listMarker: {
    width: 18,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 23,
    fontWeight: "600",
    textAlign: "left",
  },
  listText: {
    flex: 1,
  },
  assistantHeading: {
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontWeight: "600",
    marginTop: 2,
  },
  userBubbleWrap: { alignItems: "flex-end", gap: 4 },
  userBubble: {
    backgroundColor: "#20262C",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    maxWidth: "86%",
  },
  userImageBubble: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    overflow: "hidden",
  },
  userBubbleText: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "400",
  },
  userEditCard: {
    width: "86%",
    maxWidth: 620,
    backgroundColor: colors.bubble,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 8,
  },
  userEditInput: {
    width: "100%",
    minWidth: 0,
    minHeight: 48,
    maxHeight: 300,
    color: colors.text,
    backgroundColor: "#171C23",
    borderWidth: 1,
    borderColor: "#343D47",
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "400",
    margin: 0,
  },
  userEditActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
  },
  userEditCancelButton: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "transparent",
  },
  userEditCancelText: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  userEditSendButton: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: "#0F766E",
  },
  userEditSendButtonDisabled: {
    opacity: 0.45,
  },
  userEditSendText: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 2,
  },
  actionRowLeft: {
    alignSelf: "flex-start",
  },
  actionRowRight: {
    alignSelf: "flex-end",
  },
  actionButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonPressed: {
    opacity: 0.6,
  },
  actionButtonDisabled: {
    opacity: 0.35,
  },
  attachmentBlock: { gap: 8 },
  imagePreview: {
    width: 220,
    height: 160,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
  },
  imageExpandBadge: {
    position: "absolute",
    right: 8,
    bottom: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(11, 31, 36, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageViewerRoot: {
    flex: 1,
    backgroundColor: colors.viewerBg,
  },
  imageViewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  imageViewerTitle: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
    marginRight: 12,
  },
  imageViewerCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  imageViewerScroll: {
    flex: 1,
  },
  imageViewerScrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  imageViewerImage: {
    width: SCREEN.width - 16,
    height: SCREEN.height * 0.72,
  },
  documentViewerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 14,
  },
  documentViewerIcon: {
    width: 76,
    height: 76,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E6F4F1",
  },
  documentViewerName: {
    color: colors.white,
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
  },
  documentViewerMeta: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  documentViewerOpenButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 6,
  },
  documentViewerOpenText: {
    color: colors.white,
    fontWeight: "800",
    fontSize: 14,
  },
  imageViewerHint: {
    textAlign: "center",
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    fontWeight: "600",
    paddingTop: 8,
  },
  imagePlaceholder: {
    width: 220,
    minHeight: 80,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 12,
  },
  imagePlaceholderText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  documentBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 180,
  },
  documentIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  documentCopy: { flex: 1, gap: 2 },
  documentName: {
    color: colors.white,
    fontSize: 14,
    fontWeight: "800",
  },
  documentMeta: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 11,
    fontWeight: "600",
  },
  audioBubble: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    minWidth: 180,
  },
  audioIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  audioCopy: { flex: 1, gap: 4 },
  audioLabel: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  thinkingText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  thinkingDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  thinkingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#A8D5CF",
  },
  thinkingDotActive: {
    backgroundColor: colors.primary,
  },
});

import { useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { PRANA_FONT, noOutline, prana } from "../constants/prana-theme";

type Props = {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Shown instead of the list when there is nothing to choose yet. */
  disabledHint?: string;
};

/** Field-styled dropdown with a searchable list (used for State and District). */
export function PranaSelect({
  label,
  value,
  options,
  onChange,
  placeholder = "Select",
  searchPlaceholder = "Search",
  disabled = false,
  disabledHint,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return options;
    return options.filter((option) => option.toLowerCase().includes(key));
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        style={({ pressed }) => [styles.trigger, disabled && styles.triggerDisabled, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value || placeholder}`}
        accessibilityState={{ disabled, expanded: open }}
      >
        <Text style={[styles.triggerText, !value && styles.placeholder]} numberOfLines={1}>
          {value || (disabled && disabledHint ? disabledHint : placeholder)}
        </Text>
        <Feather name="chevron-down" size={16} color="#538478" />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{label}</Text>
              <Pressable onPress={close} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close">
                <Feather name="x" size={17} color="#52806B" />
              </Pressable>
            </View>
            <View style={styles.searchBox}>
              <Feather name="search" size={15} color="#7D927F" />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={searchPlaceholder}
                placeholderTextColor="#8A9B8B"
                style={styles.searchInput}
                autoFocus={Platform.OS === "web"}
                autoCorrect={false}
                accessibilityLabel={searchPlaceholder}
              />
            </View>
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 ? (
                <Text style={styles.empty}>No matches</Text>
              ) : (
                filtered.map((option) => {
                  const selected = option === value;
                  return (
                    <Pressable
                      key={option}
                      onPress={() => {
                        onChange(option);
                        close();
                      }}
                      style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.optionPressed]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option}</Text>
                      {selected ? <Feather name="check" size={16} color={prana.teal} /> : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const F = PRANA_FONT;

const styles = StyleSheet.create({
  field: { gap: 9, marginBottom: 17 },
  label: { color: prana.ink, fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  trigger: {
    minHeight: 51,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: prana.card,
    borderWidth: 1.4,
    borderColor: prana.inputBorder,
    borderRadius: 11,
    paddingHorizontal: 12,
  },
  triggerDisabled: { backgroundColor: "#F2F2DE" },
  triggerText: { flex: 1, minWidth: 0, color: prana.ink, fontFamily: F, fontSize: 13, lineHeight: 19 },
  placeholder: { color: "#8A9B8B" },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(21,57,58,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "80%",
    backgroundColor: prana.cream,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: prana.line,
    padding: 16,
    gap: 12,
    shadowColor: "#15393A",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.2,
    shadowRadius: 40,
  },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { color: prana.ink, fontFamily: F, fontSize: 18, lineHeight: 24, fontWeight: "800" },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E6EBD8",
  },
  searchBox: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1.4,
    borderColor: prana.inputBorder,
    backgroundColor: prana.card,
    borderRadius: 11,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: prana.ink,
    fontFamily: F,
    fontSize: 14,
    paddingVertical: 8,
    ...noOutline,
  },
  list: { flexGrow: 0 },
  empty: { color: prana.muted, fontFamily: F, fontSize: 13, textAlign: "center", paddingVertical: 20 },
  option: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    borderRadius: 9,
  },
  optionSelected: { backgroundColor: "#DCEFE2" },
  optionPressed: { backgroundColor: prana.attachBg },
  optionText: { color: "#245C50", fontFamily: F, fontSize: 14, lineHeight: 20 },
  optionTextSelected: { color: "#186558", fontWeight: "700" },
});

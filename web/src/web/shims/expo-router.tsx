/**
 * Web replacement for the subset of `expo-router` the app uses.
 *
 * Behaves like Expo Router's web <Stack>: each push adds a screen on top,
 * previous screens stay mounted (hidden) so their state survives a back
 * navigation, `replace` swaps the top screen, and the browser URL / back
 * button stay in sync via the History API.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { View } from "react-native";

type Params = Record<string, string | undefined>;
type Href = string | { pathname: string; params?: Record<string, unknown> };

type StackEntry = {
  key: string;
  pathname: string;
  params: Params;
};

type RouteTable = Record<string, ComponentType>;

let keySeed = 0;
const nextKey = () => `route-${++keySeed}`;

function parseHref(href: Href): { pathname: string; params: Params } {
  if (typeof href === "string") {
    const url = new URL(href, window.location.origin);
    const params: Params = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return { pathname: normalizePath(url.pathname), params };
  }
  const params: Params = {};
  for (const [key, value] of Object.entries(href.params ?? {})) {
    if (value === undefined || value === null) continue;
    params[key] = String(value);
  }
  return { pathname: normalizePath(href.pathname), params };
}

function normalizePath(pathname: string): string {
  let p = pathname || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/index") p = "/";
  return p;
}

function toUrl(entry: { pathname: string; params: Params }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(entry.params)) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();
  return `${entry.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

function routeName(pathname: string): string {
  const trimmed = pathname.replace(/^\//, "");
  return trimmed === "" ? "index" : trimmed;
}

// ---------------------------------------------------------------------------
// Navigation store (module singleton, like Expo Router's global router)
// ---------------------------------------------------------------------------

type HistoryState = { __askPranaKey?: string; __askPranaIndex?: number };

class NavigationStore {
  stack: StackEntry[] = [];
  private listeners = new Set<() => void>();

  init() {
    if (this.stack.length) return;
    const { pathname, params } = parseHref(
      `${window.location.pathname}${window.location.search}`,
    );
    const entry = { key: nextKey(), pathname, params };
    this.stack = [entry];
    window.history.replaceState(
      { __askPranaKey: entry.key, __askPranaIndex: 0 } satisfies HistoryState,
      "",
      window.location.href,
    );
    window.addEventListener("popstate", this.onPopState);
  }

  private onPopState = (event: PopStateEvent) => {
    const state = (event.state ?? {}) as HistoryState;
    const index = state.__askPranaIndex;
    const existing = this.stack.findIndex((e) => e.key === state.__askPranaKey);
    if (existing >= 0) {
      // Browser back: drop everything above the restored screen.
      this.stack = this.stack.slice(0, existing + 1);
    } else {
      const { pathname, params } = parseHref(
        `${window.location.pathname}${window.location.search}`,
      );
      const entry = { key: state.__askPranaKey ?? nextKey(), pathname, params };
      if (typeof index === "number" && index < this.stack.length) {
        this.stack = [...this.stack.slice(0, index), entry];
      } else {
        this.stack = [...this.stack, entry];
      }
    }
    this.emit();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.stack;

  private emit() {
    for (const l of this.listeners) l();
  }

  get top(): StackEntry {
    return this.stack[this.stack.length - 1];
  }

  push(href: Href) {
    const { pathname, params } = parseHref(href);
    const entry = { key: nextKey(), pathname, params };
    this.stack = [...this.stack, entry];
    window.history.pushState(
      { __askPranaKey: entry.key, __askPranaIndex: this.stack.length - 1 } satisfies HistoryState,
      "",
      toUrl(entry),
    );
    this.emit();
  }

  navigate(href: Href) {
    const { pathname } = parseHref(href);
    const existing = this.stack.findIndex((e) => e.pathname === pathname);
    if (existing >= 0 && existing < this.stack.length - 1) {
      const steps = this.stack.length - 1 - existing;
      window.history.go(-steps);
      return;
    }
    this.push(href);
  }

  replace(href: Href) {
    const { pathname, params } = parseHref(href);
    const entry = { key: nextKey(), pathname, params };
    this.stack = [...this.stack.slice(0, -1), entry];
    window.history.replaceState(
      { __askPranaKey: entry.key, __askPranaIndex: this.stack.length - 1 } satisfies HistoryState,
      "",
      toUrl(entry),
    );
    this.emit();
  }

  back() {
    if (this.stack.length > 1) {
      window.history.back();
    }
  }

  canGoBack() {
    return this.stack.length > 1;
  }

  dismissAll() {
    if (this.stack.length > 1) {
      window.history.go(-(this.stack.length - 1));
    }
  }

  setParams(params: Record<string, unknown>) {
    const top = this.top;
    const nextParams: Params = { ...top.params };
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) delete nextParams[key];
      else nextParams[key] = String(value);
    }
    const entry = { ...top, params: nextParams };
    this.stack = [...this.stack.slice(0, -1), entry];
    window.history.replaceState(
      { __askPranaKey: entry.key, __askPranaIndex: this.stack.length - 1 } satisfies HistoryState,
      "",
      toUrl(entry),
    );
    this.emit();
  }

  getState() {
    return {
      key: "root",
      index: this.stack.length - 1,
      routes: this.stack.map((e) => ({ key: e.key, name: routeName(e.pathname), params: e.params })),
    };
  }
}

export const navigationStore = new NavigationStore();

const router = {
  push: (href: Href) => navigationStore.push(href),
  navigate: (href: Href) => navigationStore.navigate(href),
  replace: (href: Href) => navigationStore.replace(href),
  back: () => navigationStore.back(),
  canGoBack: () => navigationStore.canGoBack(),
  canDismiss: () => navigationStore.canGoBack(),
  dismissAll: () => navigationStore.dismissAll(),
  dismiss: () => navigationStore.back(),
  setParams: (params: Record<string, unknown>) => navigationStore.setParams(params),
};

export { router };

function useStack() {
  return useSyncExternalStore(navigationStore.subscribe, navigationStore.getSnapshot);
}

// ---------------------------------------------------------------------------
// Per-screen context
// ---------------------------------------------------------------------------

type ScreenContextValue = { entry: StackEntry; focused: boolean };
const ScreenContext = createContext<ScreenContextValue | null>(null);
const RoutesContext = createContext<RouteTable>({});

export function useRouter() {
  return router;
}

export function usePathname(): string {
  const stack = useStack();
  return stack[stack.length - 1]?.pathname ?? "/";
}

export function useLocalSearchParams<T extends Record<string, unknown> = Params>(): T {
  const screen = useContext(ScreenContext);
  const stack = useStack();
  return (screen?.entry.params ?? stack[stack.length - 1]?.params ?? {}) as T;
}

export function useGlobalSearchParams<T extends Record<string, unknown> = Params>(): T {
  const stack = useStack();
  return (stack[stack.length - 1]?.params ?? {}) as T;
}

export function useNavigation() {
  return useMemo(
    () => ({
      getState: () => navigationStore.getState(),
      canGoBack: () => navigationStore.canGoBack(),
      goBack: () => navigationStore.back(),
    }),
    [],
  );
}

export function useRootNavigationState() {
  useStack();
  return navigationStore.getState();
}

export function useIsFocused(): boolean {
  return useContext(ScreenContext)?.focused ?? true;
}

/** Runs the callback while the screen is focused; cleans up on blur/unmount. */
export function useFocusEffect(effect: () => void | (() => void)) {
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) return;
    return effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, effect]);
}

// ---------------------------------------------------------------------------
// Stack renderer
// ---------------------------------------------------------------------------

function NotFound() {
  useEffect(() => {
    router.replace("/");
  }, []);
  return null;
}

export function Stack(_props: { screenOptions?: unknown; children?: ReactNode }) {
  const routes = useContext(RoutesContext);
  const stack = useStack();
  return (
    <View style={{ flex: 1 }}>
      {stack.map((entry, index) => {
        const focused = index === stack.length - 1;
        const Screen = routes[entry.pathname] ?? NotFound;
        return (
          <ScreenContext.Provider key={entry.key} value={{ entry, focused }}>
            <View
              style={[
                { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
                focused ? null : { display: "none" },
              ]}
            >
              <Screen />
            </View>
          </ScreenContext.Provider>
        );
      })}
    </View>
  );
}
Stack.Screen = function StackScreen(_props: { name?: string; options?: unknown }) {
  return null;
};

/** Mounts the app with a static route table (replaces Expo Router's file-based routing). */
export function RouterRoot({
  routes,
  layout: Layout,
}: {
  routes: RouteTable;
  layout: ComponentType;
}) {
  const initialized = useRef(false);
  if (!initialized.current) {
    navigationStore.init();
    initialized.current = true;
  }
  const [table] = useState(routes);
  const value = useCallback(() => table, [table]);
  return (
    <RoutesContext.Provider value={value()}>
      <Layout />
    </RoutesContext.Provider>
  );
}

export type Href_ = Href;

"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PackModal from "@/components/PackModal";
import LiveLogs, { type AgentEvent } from "@/components/LiveLogs";
import Dashboard from "@/components/Dashboard";
import Toast from "@/components/Toast";
import OfflinePill from "@/components/OfflinePill";
import { AlertCard, PreparingCard, CachedFoundCard, ReadyCard } from "@/components/OverlayCard";
import TripPlanner from "@/components/TripPlanner";
import CountdownBanner from "@/components/CountdownBanner";
import OfflineOverlay from "@/components/OfflineOverlay";
import MobileVisionWidget from "@/components/MobileVisionWidget";
import {
  ROUTE_ID, DEFAULT_ROUTE_POLYLINE,
  distanceKm, lerp, type LatLng, type DeadZone,
} from "@/lib/route";

const Map = dynamic(() => import("@/components/Map"), { ssr: false });

const API    = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
const WS_URL = API.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") + "/ws";

type User    = "user_a" | "user_b";
type Overlay =
  | { kind: "none" }
  | { kind: "alert"; deadzoneName: string; etaSeconds: number; confidence: number }
  | { kind: "preparing" }
  | { kind: "cached_found" }
  | { kind: "ready"; url: string; cached: boolean };

type ToastItem =
  | { id: number; variant: "reconnecting" }
  | { id: number; variant: "synced" };

type TripState = {
  pos: LatLng | null; segIdx: number; segT: number;
  running: boolean; insideZone: string | null;
  triggered: Set<string>;
};

type PlanState = "idle" | "planning" | "ready" | "tripping";

const STEP_MS       = 350;
const STEP_PROGRESS = 0.07;

function buildRoutePolyline(zones: DeadZone[]): LatLng[] {
  if (zones.length === 0) return DEFAULT_ROUTE_POLYLINE;
  const first = zones[0];
  const last  = zones[zones.length - 1];
  return [
    { lat: first.lat - 0.05, lng: first.lng - 0.05 },
    ...zones.map((z) => ({ lat: z.lat, lng: z.lng })),
    { lat: last.lat + 0.03, lng: last.lng + 0.05 },
  ];
}

let _toastSeq = 1;

export default function Page() {
  const [activeUser, setActiveUser] = useState<User>("user_a");

  // Plan / trip state
  const [planState, setPlanState]         = useState<PlanState>("idle");
  const [plannedZones, setPlannedZones]   = useState<DeadZone[]>([]);
  const [routePolyline, setRoutePolyline] = useState<LatLng[]>([]);
  const [routeId, setRouteId]             = useState<string>(ROUTE_ID);
  const [routeName, setRouteName]         = useState<string>("");
  const [nextZone, setNextZone]           = useState<DeadZone | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [zonePackStatus, setZonePackStatus]     = useState<Record<string, "preparing" | "ready" | "cached">>({});
  const [offlineZone, setOfflineZone]           = useState<DeadZone | null>(null);
  const [offlineSimDuration, setOfflineSimDuration] = useState<number>(0);
  const [showOfflineOverlay, setShowOfflineOverlay] = useState(false);

  // UI panels
  const [logOpen, setLogOpen] = useState(true);

  const initialTrip = useCallback(
    (): TripState => ({
      pos: routePolyline[0], segIdx: 0, segT: 0,
      running: false, insideZone: null, triggered: new Set(),
    }),
    [routePolyline]
  );

  const [trips, setTrips] = useState<Record<User, TripState>>({
    user_a: { pos: DEFAULT_ROUTE_POLYLINE[0], segIdx: 0, segT: 0, running: false, insideZone: null, triggered: new Set() },
    user_b: { pos: DEFAULT_ROUTE_POLYLINE[0], segIdx: 0, segT: 0, running: false, insideZone: null, triggered: new Set() },
  });

  const [events, setEvents]           = useState<AgentEvent[]>([]);
  const [overlay, setOverlay]         = useState<Overlay>({ kind: "none" });
  const [toasts, setToasts]           = useState<ToastItem[]>([]);
  const [offlineActive, setOfflineActive] = useState(false);
  const [packModalOpen, setPackModalOpen] = useState(false);
  const [lastPack, setLastPack]           = useState<{
    url: string; cached: boolean; html?: string | null
  } | null>(null);
  const [traceId, setTraceId]             = useState<string | null>(null);
  const [evalData, setEvalData]           = useState<{ score: number; slaPass: boolean } | null>(null);
  const [isReplaying, setIsReplaying]     = useState(false);
  const [boundsVersion, setBoundsVersion] = useState(0);
  const [wsConnected, setWsConnected]     = useState(false);

  void initialTrip; // suppress unused warning

  // ── Keep refs for WS handler (stale closures can't read current state/props)
  const planStateRef = useRef<PlanState>("idle");
  useEffect(() => { planStateRef.current = planState; }, [planState]);
  const routeIdRef = useRef<string>(ROUTE_ID);
  useEffect(() => { routeIdRef.current = routeId; }, [routeId]);

  // ── Countdown timer ───────────────────────────────────────────
  useEffect(() => {
    if (planState !== "tripping" || countdownSeconds === null) return;
    if (countdownSeconds <= 0) {
      const zone = nextZone || plannedZones[0];
      if (zone) {
        setOfflineZone(zone);
        const simDuration = Math.round((zone.duration_minutes || 4) * 60 * 0.3);
        setOfflineSimDuration(Math.max(simDuration, 5));
        setShowOfflineOverlay(true);
        setOfflineActive(true);
      }
      return;
    }
    const id = setTimeout(() => setCountdownSeconds((s) => (s !== null ? s - 1 : null)), 1000);
    return () => clearTimeout(id);
  }, [planState, countdownSeconds, nextZone, plannedZones]);

  // ── WebSocket ─────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen   = () => { setWsConnected(true); };
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as Record<string, unknown> & { type: string };
          setEvents((prev) => [...prev.slice(-200), ev]);

          // Only accept zones_ready while actively planning our OWN scan.
          // Block in "ready" and "tripping" states — other users' concurrent scans
          // on the shared WS channel would otherwise overwrite our plannedZones.
          if (ev.type === "zones_ready" && Array.isArray(ev.zones) &&
              (planStateRef.current === "idle" || planStateRef.current === "planning")) {
            const zones: DeadZone[] = (ev.zones as Record<string, unknown>[]).map((z) => ({
              id:               String(z.id || "zone"),
              name:             String(z.description || z.name || z.id || "Dead zone"),
              lat:              Number(z.lat),
              lng:              Number(z.lng),
              radius_km:        Number(z.radius_km || 0.6),
              duration_minutes: z.duration_minutes ? Number(z.duration_minutes) : undefined,
              severity:         (z.severity as DeadZone["severity"]) || "medium",
            }));
            setPlannedZones(zones);
            setRoutePolyline(buildRoutePolyline(zones));
          }

          if (ev.type === "trace_started") {
            setTraceId(String(ev.trace_id || ""));
            setEvalData(null);  // reset eval for new run
          }

          if (ev.type === "eval_complete") {
            setEvalData({ score: ev.score as number, slaPass: ev.sla_pass as boolean });
          }

          if (ev.type === "payment") {
            setOverlay((cur) =>
              cur.kind === "alert" || cur.kind === "preparing" ? { kind: "cached_found" } : cur
            );
          } else if (ev.type === "pack_ready") {
            // Filter: only accept pack_ready events that belong to THIS session's route.
            // The backend now emits route_id in every pack_ready event. If it doesn't
            // match our current routeId, this pack came from another user's concurrent
            // scan on the shared WS channel — discard it.
            const evRouteId = String(ev.route_id || "");
            const isOurPack = !evRouteId || evRouteId === routeIdRef.current;
            if (isOurPack) {
              const deadzoneId  = String(ev.deadzone_id || routeIdRef.current);
              const pack = { url: String(ev.url), cached: !!ev.cached, html: null as string | null };
              setLastPack(pack);
              setOverlay({ kind: "ready", url: String(ev.url), cached: !!ev.cached });
              setZonePackStatus((prev) => ({ ...prev, [deadzoneId]: ev.cached ? "cached" : "ready" }));
              fetch(String(ev.url))
                .then((r) => r.text())
                .then((html) => setLastPack((p) => (p && p.url === ev.url ? { ...p, html } : p)))
                .catch(() => {});
            }
          }
        } catch { /* Ignore malformed messages */ }
      };
      ws.onerror  = () => { ws?.close(); };
      ws.onclose  = () => { setWsConnected(false); reconnect = setTimeout(connect, 1500); };
    };
    connect();
    return () => { clearTimeout(reconnect); ws?.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Zone entry handling ───────────────────────────────────────
  type ZoneEntry = { user: User; pos: LatLng; dzId: string; dzName: string; zone: DeadZone };
  const pendingZoneEntries  = useRef<ZoneEntry[]>([]);
  const pendingTripComplete = useRef(false);

  const handleZoneEnter = useCallback((user: User, pos: LatLng, dzId: string, dzName: string, zone: DeadZone) => {
    setOverlay({ kind: "alert", deadzoneName: dzName, etaSeconds: (zone.duration_minutes || 4) * 60, confidence: 92 });
    setTimeout(() => {
      setOverlay((cur) => cur.kind === "alert" ? { kind: "preparing" } : cur);
    }, 1600);
    setZonePackStatus((prev) => ({ ...prev, [dzId]: "preparing" }));

    fetch(`${API}/signal`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        user_id: user, lat: pos.lat, lng: pos.lng,
        eta_seconds:      (zone.duration_minutes || 4) * 60,
        route_id:         routeId,
        deadzone_id:      dzId,
        duration_minutes: zone.duration_minutes || 4,
        severity:         zone.severity || "medium",
        zone_description: zone.name,
        route:            routeName,
      }),
    }).catch(() => {});
    setOfflineActive(true);
    // Advance nextZone to the next unvisited zone on this route
    setNextZone(() => {
      const all = plannedZonesRef.current;
      const idx = all.findIndex((z) => z.id === dzId);
      return idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, routeName]);

  // ── Animation loop ────────────────────────────────────────────
  const routePolylineRef = useRef(routePolyline);
  useEffect(() => { routePolylineRef.current = routePolyline; }, [routePolyline]);
  const plannedZonesRef = useRef(plannedZones);
  useEffect(() => { plannedZonesRef.current = plannedZones; }, [plannedZones]);

  useEffect(() => {
    const id = setInterval(() => {
      setTrips((prev) => {
        const next = { ...prev };
        (["user_a", "user_b"] as User[]).forEach((u) => {
          const t = prev[u];
          if (!t.running) return;
          const poly = routePolylineRef.current;
          let segIdx = t.segIdx, segT = t.segT + STEP_PROGRESS;
          while (segT >= 1 && segIdx < poly.length - 2) { segT -= 1; segIdx += 1; }
          const atEnd = segIdx >= poly.length - 2 && segT >= 1;
          const pos   = atEnd ? poly[poly.length - 1] : lerp(poly[segIdx], poly[segIdx + 1], segT);

          const zones    = plannedZonesRef.current;
          const triggered = new Set(t.triggered);
          let insideZone: string | null = null;
          let justEntered = false;
          let enteredZone: DeadZone | null = null;

          for (const dz of zones) {
            if (distanceKm(pos, { lat: dz.lat, lng: dz.lng }) <= dz.radius_km) {
              insideZone = dz.id;
              if (!triggered.has(dz.id)) {
                triggered.add(dz.id);
                justEntered = true;
                enteredZone = dz;
                pendingZoneEntries.current.push({ user: u, pos, dzId: dz.id, dzName: dz.name, zone: dz });
              }
              break;
            }
          }
          if (atEnd && u === "user_a") pendingTripComplete.current = true;
          next[u] = { ...t, segIdx, segT: atEnd ? 1 : segT, pos, insideZone, triggered, running: !atEnd && !justEntered };
          void enteredZone;
        });
        return next;
      });
    }, STEP_MS);
    return () => clearInterval(id);
  }, []);

  // Drain pending zone entries
  useEffect(() => {
    const entries = pendingZoneEntries.current.splice(0);
    entries.forEach(({ user, pos, dzId, dzName, zone }) =>
      handleZoneEnter(user, pos, dzId, dzName, zone)
    );
    if (pendingTripComplete.current) {
      pendingTripComplete.current = false;
      handleTripComplete();
    }
  });

  function pushToast(t: ToastItem) { setToasts((arr) => [...arr, t]); }
  function dropToast(id: number)   { setToasts((arr) => arr.filter((t) => t.id !== id)); }

  // ── Plan complete ─────────────────────────────────────────────
  function handlePlanComplete(zones: DeadZone[], rid: string, route: string) {
    const resolved = zones;
    setPlannedZones(resolved);
    setRouteId(rid);
    setRouteName(route);
    setPlanState("ready");
    setRoutePolyline(buildRoutePolyline(resolved));
    setNextZone(resolved[0] || null);
    // Trigger map pan/zoom to show the new route
    setBoundsVersion((v) => v + 1);
  }

  // ── Start trip ────────────────────────────────────────────────
  function handleStartTrip() {
    const zones = plannedZones;
    const poly  = buildRoutePolyline(zones);
    setRoutePolyline(poly);
    setPlanState("tripping");
    setOverlay({ kind: "none" });
    setOfflineActive(false);
    setToasts([]);
    setEvents([]);
    setShowOfflineOverlay(false);
    setOfflineZone(null);
    setCountdownSeconds(20);
    setNextZone(zones[0] || null);
    setZonePackStatus({});
    setLastPack(null);       // clear stale pack so modal never shows wrong-route content
    const startPos = poly[0];
    setTrips({
      user_a: { pos: startPos, segIdx: 0, segT: 0, running: true,  insideZone: null, triggered: new Set() },
      user_b: { pos: startPos, segIdx: 0, segT: 0, running: false, insideZone: null, triggered: new Set() },
    });
    setActiveUser("user_a");
  }

  // ── Legacy per-user controls ──────────────────────────────────
  function startTrip(u: User) {
    setOverlay({ kind: "none" });
    setOfflineActive(false);
    setToasts([]);
    setEvents([]);
    const poly = routePolyline;
    setTrips((p) => ({
      ...p,
      [u]: { pos: poly[0], segIdx: 0, segT: 0, running: true, insideZone: null, triggered: new Set() },
    }));
    setActiveUser(u);
    if (planState === "idle") {
      setPlanState("tripping");
      setNextZone(plannedZones[0] || null);
      setCountdownSeconds(20);
    }
  }
  function resetTrip(u: User) {
    setTrips((p) => ({
      ...p,
      [u]: { pos: routePolyline[0], segIdx: 0, segT: 0, running: false, insideZone: null, triggered: new Set() },
    }));
    setOverlay({ kind: "none" });
    setOfflineActive(false);
    setToasts([]);
  }

  // ── Offline sim done ──────────────────────────────────────────
  function handleOfflineDone() {
    setShowOfflineOverlay(false);
    setOfflineActive(false);
    setOfflineZone(null);
    pushToast({ id: _toastSeq++, variant: "synced" });
    // Resume trip after the dead zone simulation ends
    setTrips((prev) => {
      const t = prev.user_a;
      return t.running ? prev : { ...prev, user_a: { ...t, running: true } };
    });
  }

  const dots = useMemo(
    () => (["user_a", "user_b"] as User[]).map((u) => ({ user: u, pos: trips[u].pos })),
    [trips]
  );

  // "idle" and "planning" → full-screen modal (map hidden, nothing to show yet)
  // "ready"              → compact corner card (map visible with plotted zones)
  const showPlannerModal  = planState === "idle" || planState === "planning";
  const showPlannerCard   = planState === "ready";
  const showPlanner       = showPlannerModal || showPlannerCard;
  const showCountdown  = planState === "tripping" && nextZone !== null && countdownSeconds !== null;
  // Derive pack status from overlay state so CountdownBanner and ReadyCard
  // are always in sync — avoids the desync where overlay shows "ready" but
  // banner still shows "building pack" (caused by deadzone_id mismatches).
  const currentPackStatus: "preparing" | "ready" | "cached" =
    overlay.kind === "ready"        ? (overlay.cached ? "cached" : "ready")
    : overlay.kind === "cached_found" ? "cached"
    : nextZone ? (zonePackStatus[nextZone.id] || "preparing") : "preparing";

  // ── LOG_DRAWER_WIDTH ─────────────────────────────────────────
  // Replay handler
  async function handleReplay() {
    if (!traceId || isReplaying) return;
    setIsReplaying(true);
    setEvents([]);
    setEvalData(null);
    try {
      const resp = await fetch(`${API}/trace/${traceId}`);
      if (!resp.ok) throw new Error("trace not found");
      const data = (await resp.json()) as { events: AgentEvent[] };
      const traceEvents = data.events;
      for (let i = 0; i < traceEvents.length; i++) {
        const ev = traceEvents[i];
        const nextEv = traceEvents[i + 1];
        const delay = nextEv
          ? Math.min(Math.max((Number(nextEv.t_ms) || 0) - (Number(ev.t_ms) || 0), 0), 600)
          : 0;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "pack_ready") {
          setOverlay({ kind: "ready", url: String(ev.url), cached: !!ev.cached });
        }
        if (ev.type === "eval_complete") {
          setEvalData({ score: ev.score as number, slaPass: ev.sla_pass as boolean });
        }
        if (delay > 20) await new Promise((r) => setTimeout(r, delay));
      }
    } catch (e) {
      console.error("Replay failed:", e);
    } finally {
      setIsReplaying(false);
    }
  }

  function handleTripComplete() {
    // Show 'back online' toast, then land on the "ready" compact card
    // so the map stays visible with the route still plotted.
    // The user can re-plan from there without a jarring full-screen reset.
    pushToast({ id: _toastSeq++, variant: "synced" });
    setTimeout(() => {
      const poly = routePolylineRef.current;
      const start = poly[0] || DEFAULT_ROUTE_POLYLINE[0];
      // Stay in "ready" — compact card, map visible, zones still shown.
      // User must explicitly click "Re-plan" in TripPlanner to go idle.
      setPlanState("ready");
      setOverlay({ kind: "none" });
      setOfflineActive(false);
      setCountdownSeconds(null);
      setNextZone(null);
      setTrips({
        user_a: { pos: start, segIdx: 0, segT: 0, running: false, insideZone: null, triggered: new Set() },
        user_b: { pos: start, segIdx: 0, segT: 0, running: false, insideZone: null, triggered: new Set() },
      });
    }, 3500);
  }

  // Resume the trip animation 5 s after ReadyCard appears, but keep the card
  // visible so the user can still tap "Open Continuity Pack" to read resources.
  // The overlay dismisses naturally when the next zone entry triggers a new alert.
  useEffect(() => {
    if (overlay.kind !== "ready" || planState !== "tripping") return;
    const timer = setTimeout(() => {
      // Only resume the animation — do NOT close the ReadyCard.
      setTrips((prev) => {
        const t = prev.user_a;
        return t.running ? prev : { ...prev, user_a: { ...t, running: true } };
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [overlay.kind, planState]);

  const LOG_W = 300;

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="relative h-screen overflow-hidden" style={{ background: "#050810" }}>

      {/* ── Ambient glow orbs ─────────────────────────────────── */}
      <div
        className="pointer-events-none absolute -top-40 -left-40 w-[700px] h-[700px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(0,212,255,0.06) 0%, transparent 65%)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-40 w-[600px] h-[600px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(139,92,246,0.05) 0%, transparent 65%)" }}
      />

      {/* ── Full-bleed map ────────────────────────────────────── */}
      <div className="absolute inset-0">
        <Map
          dots={dots}
          activeUser={activeUser}
          deadZones={plannedZones}
          routePolyline={routePolyline}
          nextZone={nextZone}
          boundsVersion={boundsVersion}
        />
      </div>

      {/* ── Top bar: mobile-vision banner + navigation ────────── */}
      <div
        className="absolute top-0 left-0 right-0 z-[1100]"
        style={{
          background:    "rgba(5, 8, 16, 0.88)",
          backdropFilter:"blur(18px)",
          borderBottom:  "1px solid rgba(0, 212, 255, 0.12)",
          boxShadow:     "0 1px 40px rgba(0,0,0,0.4)",
        }}
      >
        {/* Banner row — promotes the mobile vision */}
        <a
          href="/mobile"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 px-4 py-1.5 text-[11px] font-medium group transition-all hover:bg-white/[0.02]"
          style={{
            background: "linear-gradient(90deg, rgba(0,212,255,0.10) 0%, rgba(139,92,246,0.10) 100%)",
            borderBottom: "1px solid rgba(0,212,255,0.10)",
            color: "#7dd3fc",
            letterSpacing: "0.02em",
          }}
        >
          <span>📱</span>
          <span className="hidden sm:inline">This is the live demo. Explore the full mobile experience we&apos;re planning</span>
          <span className="sm:hidden">See the mobile vision</span>
          <span className="transition-transform group-hover:translate-x-1" style={{ color: "#a78bfa" }}>→</span>
        </a>

      {/* Nav row */}
      <div className="px-4 py-2.5 flex items-center justify-between">
        {/* Left — logo */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="relative">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: "#00d4ff", boxShadow: "0 0 8px #00d4ff" }}
              />
              <span
                className="absolute inset-0 inline-block w-2 h-2 rounded-full animate-ping"
                style={{ background: "#00d4ff", opacity: 0.4 }}
              />
            </div>
            <span
              className="font-bold text-sm tracking-tight"
              style={{ color: "#e2e8f0", letterSpacing: "-0.01em" }}
            >
              DeadZone
            </span>
            <span
              className="text-[10px] tracking-widest uppercase px-1.5 py-0.5 rounded"
              style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.2)" }}
            >
              BETA
            </span>
          </div>
          <span className="text-xs text-slate-600 hidden md:block tracking-wide">
            live · always ready
          </span>
          {/* WS status dot */}
          <span
            className="hidden sm:flex items-center gap-1 text-[10px] font-medium tracking-wide"
            style={{ color: wsConnected ? "#10b981" : "#94a3b8" }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: wsConnected ? "#10b981" : "#475569",
                boxShadow: wsConnected ? "0 0 6px #10b981" : "none",
              }}
            />
            {wsConnected ? "live" : "connecting"}
          </span>
        </div>

        {/* Right — controls */}
        <div className="flex items-center gap-1.5">
          {/* User switcher */}
          {(["user_a", "user_b"] as User[]).map((u) => (
            <button
              key={u}
              onClick={() => setActiveUser(u)}
              className="px-2.5 py-1 text-xs rounded-lg font-medium transition-all duration-200"
              style={
                activeUser === u
                  ? u === "user_a"
                    ? { background: "rgba(0,212,255,0.15)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.3)" }
                    : { background: "rgba(139,92,246,0.15)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }
                  : { background: "rgba(255,255,255,0.05)", color: "#64748b", border: "1px solid rgba(255,255,255,0.07)" }
              }
            >
              {u === "user_a" ? "Driver" : "Rider"}
            </button>
          ))}

          {/* Trip controls */}
          {planState === "tripping" && (
            <>
              <button
                onClick={() => startTrip(activeUser)}
                className="ml-1.5 px-2.5 py-1 text-xs rounded-lg font-medium transition-all duration-200"
                style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.25)" }}
              >
                ▶ restart
              </button>
              <button
                onClick={() => resetTrip(activeUser)}
                className="px-2.5 py-1 text-xs rounded-lg font-medium transition-all duration-200"
                style={{ background: "rgba(255,255,255,0.05)", color: "#64748b", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                reset
              </button>
            </>
          )}
          {planState !== "tripping" && (
            <button
              onClick={() => { setPlanState("idle"); setPlannedZones([]); setRoutePolyline([]); }}
              className="ml-1.5 px-2.5 py-1 text-xs rounded-lg font-medium transition-all duration-200"
              style={{ background: "rgba(255,255,255,0.05)", color: "#64748b", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              new trip
            </button>
          )}

          {/* Replay button */}
          {traceId && !isReplaying && (
            <button
              onClick={handleReplay}
              className="ml-1.5 px-2.5 py-1 text-xs rounded-lg font-medium transition-all duration-200 flex items-center gap-1.5"
              style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.25)" }}
              title={`Replay trace ${traceId}`}
            >
              <span>⏮</span>
              <span className="hidden sm:inline">Replay</span>
            </button>
          )}
          {isReplaying && (
            <div
              className="ml-1.5 px-2.5 py-1 text-xs rounded-lg font-medium flex items-center gap-1.5"
              style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.25)" }}
            >
              <span className="animate-pulse">●</span>
              <span className="hidden sm:inline">Replaying</span>
            </div>
          )}

          {/* Log toggle */}
          <button
            onClick={() => setLogOpen((v) => !v)}
            className="ml-1.5 px-2.5 py-1 text-xs rounded-lg font-medium transition-all duration-200 flex items-center gap-1.5"
            style={
              logOpen
                ? { background: "rgba(0,212,255,0.12)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.25)" }
                : { background: "rgba(255,255,255,0.05)", color: "#64748b", border: "1px solid rgba(255,255,255,0.07)" }
            }
          >
            <span>⚡</span>
            <span className="hidden sm:inline">Log</span>
            <span>{logOpen ? "›" : "‹"}</span>
          </button>
        </div>
      </div>
      </div>

      {/* ── Trip planner — single stable instance, repositions modal→card ── */}
      {/* Keeping one component tree node ensures React never unmounts TripPlanner
          when planState flips idle→ready, so detectedZones/mode/selected survive. */}
      {showPlanner && (
        <>
          {/* Backdrop — only in modal mode, has no state so safe to mount/unmount */}
          {showPlannerModal && (
            <div
              className="absolute inset-0 z-[1499]"
              style={{ background: "rgba(5,8,16,0.7)", backdropFilter: "blur(4px)" }}
            />
          )}
          {/* Wrapper repositions without unmounting TripPlanner */}
          <div
            className="absolute z-[1500]"
            style={
              showPlannerModal
                ? { inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }
                : { top: "3.5rem", left: "1rem", width: "min(420px, calc(100vw - 2rem))", padding: "0.75rem" }
            }
          >
            <TripPlanner
              onPlanComplete={handlePlanComplete}
              onStartTrip={handleStartTrip}
              apiBase={API}
              planState={planState === "planning" ? "planning" : planState === "ready" ? "ready" : "idle"}
            />
          </div>
        </>
      )}

      {/* ── Countdown banner ──────────────────────────────────── */}
      {showCountdown && !showOfflineOverlay && (
        <div
          className="absolute left-4 z-[1200] transition-all duration-300"
          style={{
            top:   "6.5rem",
            right: logOpen ? `${LOG_W + 16}px` : "1rem",
          }}
        >
          <CountdownBanner
            zone={nextZone!}
            secondsUntil={countdownSeconds!}
            packStatus={currentPackStatus}
          />
        </div>
      )}

      {/* ── Center overlay cards ──────────────────────────────── */}
      {overlay.kind !== "none" && !showPlanner && !showOfflineOverlay && (
        <div
          className="absolute z-[1200] flex justify-center transition-all duration-300"
          style={{
            top:   showCountdown ? "10rem" : "7rem",
            left:  "1rem",
            right: logOpen ? `${LOG_W + 16}px` : "1rem",
          }}
        >
          <div style={{ width: "100%", maxWidth: "520px" }}>
            {overlay.kind === "alert" && (
              <AlertCard
                deadzoneName={overlay.deadzoneName}
                etaSeconds={overlay.etaSeconds}
                confidence={overlay.confidence}
                onPrepare={() => setOverlay({ kind: "preparing" })}
                onSwitch={() => setOverlay({ kind: "none" })}
                onStay={() => setOverlay({ kind: "preparing" })}
              />
            )}
            {overlay.kind === "preparing"    && <PreparingCard />}
            {overlay.kind === "cached_found" && <CachedFoundCard />}
            {overlay.kind === "ready" && (
              <ReadyCard
                cached={overlay.cached}
                evalScore={evalData?.score}
                slaPass={evalData?.slaPass}
                onOpen={() => setPackModalOpen(true)}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Toasts ────────────────────────────────────────────── */}
      <div className="absolute z-[1300] flex flex-col gap-2" style={{ top: "6rem", right: logOpen ? `${LOG_W + 12}px` : "1rem" }}>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant}
            onDismiss={() => dropToast(t.id)}
          />
        ))}
      </div>

      {/* ── Offline pill ──────────────────────────────────────── */}
      {offlineActive && !showOfflineOverlay && (
        <div className="absolute bottom-14 left-4 z-[1200]">
          <OfflinePill />
        </div>
      )}

      {/* ── Agent log drawer (right side) ─────────────────────── */}
      <div
        className="absolute bottom-11 right-0 z-[1050] flex flex-col"
        style={{
          top:       "5rem",
          width:     `${LOG_W}px`,
          background:"rgba(5, 8, 16, 0.94)",
          backdropFilter: "blur(18px)",
          borderLeft: "1px solid rgba(0, 212, 255, 0.1)",
          transform: logOpen ? "translateX(0)" : `translateX(${LOG_W}px)`,
          transition:"transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <LiveLogs
          events={events}
          traceId={traceId ?? undefined}
          isReplaying={isReplaying}
          onReplay={traceId ? handleReplay : undefined}
        />
      </div>

      {/* ── Dashboard strip (bottom) ──────────────────────────── */}
      <div className="absolute bottom-0 left-0 right-0 z-[1050]">
        <Dashboard />
      </div>

      {/* ── Floating mobile vision preview (visible above planner backdrop) ── */}
      <MobileVisionWidget />

      {/* ── Offline simulation overlay ────────────────────────── */}
      {showOfflineOverlay && offlineZone && (
        <OfflineOverlay
          durationSeconds={offlineSimDuration}
          onDone={handleOfflineDone}
        />
      )}

      {/* ── Pack modal ────────────────────────────────────────── */}
      {packModalOpen && lastPack && (
        <PackModal
          url={lastPack.url}
          html={lastPack.html}
          cached={lastPack.cached}
          onClose={() => setPackModalOpen(false)}
        />
      )}
    </div>
  );
}

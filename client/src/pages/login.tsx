import { useRef, useState } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useLocation } from "wouter";
import { Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { queryClient } from "@/lib/queryClient";

function DellTechLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 260 64" className={className} xmlns="http://www.w3.org/2000/svg" aria-label="Dell Technologies">
      {/* Circle */}
      <circle cx="32" cy="32" r="31" fill="#007DB8" />
      {/* "dell" — bold italic, white */}
      <text
        x="32" y="42"
        textAnchor="middle"
        fill="white"
        fontSize="26"
        fontWeight="bold"
        fontStyle="italic"
        fontFamily="Arial, Helvetica, sans-serif"
        letterSpacing="-1"
      >
        dell
      </text>
      {/* Dell */}
      <text
        x="74" y="26"
        fill="#007DB8"
        fontSize="22"
        fontWeight="700"
        fontFamily="Arial, Helvetica, sans-serif"
      >
        Dell
      </text>
      {/* Technologies */}
      <text
        x="74" y="48"
        fill="#94A3B8"
        fontSize="14"
        fontFamily="Arial, Helvetica, sans-serif"
        letterSpacing="2.5"
      >
        Technologies
      </text>
    </svg>
  );
}

export default function Login() {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();

  // 3D tilt tracking
  const cardRef = useRef<HTMLDivElement>(null);
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const rotateX = useSpring(useTransform(rawY, [-0.5, 0.5], [12, -12]), { stiffness: 200, damping: 28 });
  const rotateY = useSpring(useTransform(rawX, [-0.5, 0.5], [-12, 12]), { stiffness: 200, damping: 28 });
  const glare = useTransform([rawX, rawY], ([x, y]: number[]) =>
    `radial-gradient(ellipse at ${(x + 0.5) * 100}% ${(y + 0.5) * 100}%, rgba(255,255,255,0.13), transparent 65%)`
  );

  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    rawX.set((e.clientX - rect.left) / rect.width - 0.5);
    rawY.set((e.clientY - rect.top) / rect.height - 0.5);
  }
  function onMouseLeave() {
    rawX.set(0);
    rawY.set(0);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) { setError("Please enter your GridWeave token."); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as any).message || "Login failed.");
        return;
      }
      queryClient.clear();
      navigate("/");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#020817]">

      {/* Background: animated grid */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0,125,184,0.07) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,125,184,0.07) 1px, transparent 1px)
          `,
          backgroundSize: "56px 56px",
        }}
      />

      {/* Ambient glow blobs */}
      <div className="pointer-events-none absolute -left-48 top-1/4 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-48 bottom-1/4 h-80 w-80 rounded-full bg-cyan-500/8 blur-3xl" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[700px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-900/15 blur-3xl" />

      {/* Floating 3-D accent planes */}
      <motion.div
        animate={{ y: [0, -14, 0], rotateZ: [0, 3, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        className="pointer-events-none absolute left-[8%] top-[18%] h-24 w-24 rounded-xl border border-blue-500/20 bg-blue-500/5"
        style={{ transform: "perspective(600px) rotateX(20deg) rotateY(-15deg)" }}
      />
      <motion.div
        animate={{ y: [0, 10, 0], rotateZ: [0, -2, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
        className="pointer-events-none absolute bottom-[22%] right-[10%] h-16 w-16 rounded-lg border border-cyan-400/20 bg-cyan-400/5"
        style={{ transform: "perspective(600px) rotateX(-15deg) rotateY(20deg)" }}
      />
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut", delay: 3 }}
        className="pointer-events-none absolute right-[18%] top-[30%] h-10 w-10 rounded-md border border-blue-400/15 bg-blue-400/5"
        style={{ transform: "perspective(600px) rotateX(30deg) rotateY(10deg)" }}
      />

      {/* 3-D card area */}
      <div
        ref={cardRef}
        className="relative z-10 w-full max-w-sm px-4"
        style={{ perspective: "1100px" }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <motion.div
          style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
          className="relative"
        >
          {/* Drop shadow layer — sits behind the card in Z */}
          <div
            className="absolute inset-4 rounded-2xl bg-blue-500/25 blur-2xl"
            style={{ transform: "translateZ(-50px) scale(0.9)" }}
          />

          {/* Card surface */}
          <div
            className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-900/85 shadow-2xl backdrop-blur-xl"
            style={{ transformStyle: "preserve-3d" }}
          >
            {/* Dynamic glare */}
            <motion.div
              className="pointer-events-none absolute inset-0 rounded-2xl"
              style={{ background: glare }}
            />

            {/* Subtle top edge highlight */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-400/50 to-transparent" />

            <div className="px-8 pb-8 pt-9">
              {/* Dell Technologies logo — pushed forward */}
              <div style={{ transform: "translateZ(28px)" }} className="mb-7 flex justify-center">
                <DellTechLogo className="h-14 w-auto" />
              </div>

              {/* Divider with label */}
              <div style={{ transform: "translateZ(18px)" }} className="mb-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-600/60 to-transparent" />
                <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">
                  Dell Technologies - Distributed Architecture | S3 Client
                </span>
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-600/60 to-transparent" />
              </div>

              <form onSubmit={handleSubmit} style={{ transformStyle: "preserve-3d" }}>
                {/* Token input */}
                <div style={{ transform: "translateZ(22px)" }} className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-400">
                    GridWeave Token
                  </label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
                    <Input
                      type={showToken ? "text" : "password"}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="gw_••••••••••••••••"
                      className="border-slate-700 bg-slate-800/70 pl-9 pr-9 text-slate-100 placeholder:text-slate-600 focus-visible:border-blue-500 focus-visible:ring-blue-500/30"
                      autoComplete="current-password"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                      tabIndex={-1}
                    >
                      {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  {error && (
                    <p className="text-xs text-red-400">{error}</p>
                  )}
                </div>

                {/* Sign-in button — most forward Z layer */}
                <div style={{ transform: "translateZ(40px)" }} className="mt-6">
                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-[#007DB8] text-white shadow-lg shadow-blue-950/60 hover:bg-[#0091d6] active:scale-[0.98] transition-all"
                  >
                    {loading
                      ? <><Loader2 className="mr-2 size-4 animate-spin" />Signing in…</>
                      : <><ShieldCheck className="mr-2 size-4" />Sign in</>
                    }
                  </Button>
                </div>
              </form>

              <p style={{ transform: "translateZ(12px)" }} className="mt-5 text-center text-[11px] text-slate-600">
                Your token stays server-side — never sent to the browser.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

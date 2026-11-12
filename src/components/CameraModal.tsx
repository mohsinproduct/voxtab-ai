/**
 * @file CameraModal.tsx
 * @description Clean 9:16 vertical receipt camera viewfinder with zero text clutter inside the frame.
 * Crops the captured image to the 9:16 vertical receipt frame at high resolution.
 */
'use client';

import React, { useRef, useState, useEffect } from 'react';
import { Camera, X, RefreshCw, AlertCircle, Zap, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui';

interface CameraModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (base64Image: string) => void;
}

const RECEIPT_ASPECT = 9 / 16; // 9:16 vertical receipt ratio

export function CameraModal({ isOpen, onClose, onCapture }: CameraModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);

  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [supportsTorch, setSupportsTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return;
    }

    let isCancelled = false;

    async function startCamera() {
      setIsStarting(true);
      setCameraError(null);
      setZoomRange(null);
      setSupportsTorch(false);
      setTorchOn(false);
      stopCamera();

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access is not supported by this browser.');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1920 },
          },
          audio: false,
        });

        if (isCancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === 'function') {
          const caps = track.getCapabilities() as Record<string, any>;
          if (caps.zoom && typeof caps.zoom.min === 'number' && caps.zoom.max > caps.zoom.min) {
            setZoomRange({
              min: caps.zoom.min,
              max: caps.zoom.max,
              step: caps.zoom.step || 0.1,
            });
            setZoom(caps.zoom.min);
          }
          if (caps.torch) {
            setSupportsTorch(true);
          }
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setIsStarting(false);
      } catch (err: any) {
        if (isCancelled) return;
        console.error('Camera start error:', err);
        setCameraError(
          err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access in your browser address bar, or upload a photo instead.'
            : err.message || 'Unable to access camera.'
        );
        setIsStarting(false);
      }
    }

    startCamera();

    return () => {
      isCancelled = true;
      stopCamera();
    };
  }, [isOpen, facingMode]);

  const applyZoom = async (nextZoom: number) => {
    setZoom(nextZoom);
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: nextZoom } as any] });
    } catch {}
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
    } catch {}
  };

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video) return;

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const videoAspect = vw / vh;

    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (videoAspect > RECEIPT_ASPECT) {
      sw = Math.round(vh * RECEIPT_ASPECT);
      sx = Math.round((vw - sw) / 2);
    } else {
      sh = Math.round(vw / RECEIPT_ASPECT);
      sy = Math.round((vh - sh) / 2);
    }

    const MAX_H = 1800;
    const scale = sh > MAX_H ? MAX_H / sh : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.92);

    stopCamera();
    onCapture(base64);
    onClose();
  };

  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-4 animate-fade-in">
      <div className="relative w-full max-w-[330px] max-h-[92dvh] bg-[var(--bg-card)] border border-white/15 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        {/* Clean Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[var(--bg-surface)] shrink-0">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-[var(--brand)]"/>
            <span className="font-bold text-xs sm:text-sm text-[var(--fg-primary)]">Capture Receipt</span>
          </div>

          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="w-7 h-7 rounded-full flex items-center justify-center text-[var(--fg-muted)] hover:text-white hover:bg-[var(--bg-muted)] transition-colors cursor-pointer"
            aria-label="Close camera"
          >
            <X className="w-4 h-4"/>
          </button>
        </div>

        {/* Clean 9:16 Vertical Receipt Viewfinder (Zero text overlays) */}
        <div className="relative w-full aspect-[9/16] max-h-[62dvh] mx-auto bg-black flex items-center justify-center overflow-hidden">
          {cameraError ? (
            <div className="p-6 text-center space-y-3 max-w-xs">
              <AlertCircle className="w-9 h-9 text-[#ff7a7a] mx-auto"/>
              <p className="text-sm font-semibold text-[#ff7a7a]">Camera Unavailable</p>
              <p className="text-xs text-[var(--fg-muted)]">{cameraError}</p>
              <Button onClick={() => {
                stopCamera();
                onClose();
              }}
                size="sm"
                variant="secondary"
              >
                Close
              </Button>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="w-full h-full object-cover"
              />

              {/* Subtle 9:16 receipt border guide with zero text */}
              <div className="absolute inset-3 border-2 border-dashed border-[var(--brand)]/55 rounded-xl pointer-events-none" />

              {isStarting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-3">
                  <div className="w-8 h-8 rounded-full border-2 border-[var(--brand)] border-t-transparent animate-spin" />
                  <span className="text-xs text-white/80">Opening camera…</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Optional Hardware Zoom & Flashlight Bar */}
        {!cameraError && (zoomRange || supportsTorch) && (
          <div className="px-4 py-2 bg-[var(--bg-muted)] border-t border-white/10 flex items-center justify-between gap-4 shrink-0">
            {zoomRange && (
              <div className="flex items-center gap-2 flex-1">
                <ZoomIn className="w-3.5 h-3.5 text-[var(--brand)] shrink-0"/>
                <input
                  type="range"
                  min={zoomRange.min}
                  max={zoomRange.max}
                  step={zoomRange.step}
                  value={zoom}
                  onChange={(e) => applyZoom(parseFloat(e.target.value))}
                  className="w-full accent-[var(--brand)] cursor-pointer"
                  aria-label="Camera zoom"
                />
                <span className="mono text-[10px] text-[var(--fg-secondary)] shrink-0">
                  {zoom.toFixed(1)}×
                </span>
              </div>
            )}
            {supportsTorch && (
              <button
                type="button"
                onClick={toggleTorch}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer ${
                  torchOn
                    ? 'bg-[var(--brand)] text-[#1b1418] border-[var(--brand)]'
                    : 'bg-[var(--bg-surface)] text-[var(--fg-secondary)] border-white/10'
                }`}
              >
                <Zap className="w-3 h-3"/>
                <span>Flash</span>
              </button>
            )}
          </div>
        )}

        {/* Controls Footer */}
        {!cameraError && (
          <div className="p-3.5 flex items-center justify-between gap-2 bg-[var(--bg-surface)] border-t border-white/10 shrink-0">
            <button
              type="button"
              onClick={toggleFacingMode}
              className="p-2.5 rounded-full bg-[var(--bg-muted)] hover:bg-white/10 text-[var(--fg-secondary)] border border-white/10 transition-colors cursor-pointer"
              title="Switch front/back camera"
            >
              <RefreshCw className="w-4 h-4"/>
            </button>

            <button
              type="button"
              onClick={handleCapture}
              disabled={isStarting}
              className="px-5 py-2.5 rounded-full bg-[var(--brand)] hover:bg-[var(--brand-light)] text-[#1b1418] font-bold text-xs sm:text-sm shadow-[0_0_24px_var(--brand-glow)] flex items-center gap-2 active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
            >
              <Camera className="w-4 h-4"/>
              <span>Snap Receipt</span>
            </button>

            <Button onClick={() => {
              stopCamera();
              onClose();
            }} size="sm" variant="secondary">
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

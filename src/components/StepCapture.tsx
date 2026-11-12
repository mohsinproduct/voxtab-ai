/**
 * @file StepCapture.tsx
 * @description Step 1: Receipt capture via camera or file upload, featuring an animated
 * "Try sample" badge emerging from the top-right of the Receipt icon, and a live laser-scan
 * animation on uploaded receipts.
 */
'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui';
import { CameraModal } from '@/components/CameraModal';
import { mediaProblem, isTouchDevice, insecureContextHelp } from '@/lib/mediaSupport';
import {
  Camera,
  Upload,
  X,
  Receipt,
  ArrowUpRight,
} from 'lucide-react';

interface StepCaptureProps {
  /** Current receipt image (base64 data URL) */
  receiptImage: string | null;
  onSetImage: (img: string | null, isSample?: boolean) => void;
  onNext: (imgOverride?: string) => void;
  loading?: boolean;
  error?: string | null;
}

export function compressReceiptImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image for compression'));
      img.onload = () => {
        const MAX_DIM = 1600;
        let width = img.width;
        let height = img.height;

        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', 0.85);
        resolve(compressed);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function generateSampleReceiptDataUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 820;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'center';
  ctx.font = 'bold 28px monospace';
  ctx.fillText('METRO CORNER MARKET', 320, 60);
  ctx.font = '16px monospace';
  ctx.fillText('742 Evergreen Terrace • Receipt #409', 320, 92);

  ctx.textAlign = 'left';
  ctx.fillText('----------------------------------------', 50, 130);
  ctx.font = 'bold 18px monospace';
  ctx.fillText('QTY  ITEM                         TOTAL', 50, 160);
  ctx.font = '18px monospace';
  ctx.fillText('----------------------------------------', 50, 185);

  const lines: [string, string][] = [
    ['1x   Artisan Pizza Pack', '$18.00'],
    ['2x   Organic Cold Brew', '$28.00'],
    ['3x   Sparkling Water', '$12.00'],
    ['1x   First Aid & Vitamins', '$10.00'],
    ['1x   Household Essentials', '$12.00'],
  ];
  let y = 225;
  for (const [left, right] of lines) {
    ctx.textAlign = 'left';
    ctx.fillText(left, 50, y);
    ctx.textAlign = 'right';
    ctx.fillText(right, 590, y);
    y += 44;
  }

  ctx.textAlign = 'left';
  ctx.fillText('----------------------------------------', 50, y + 10);
  const totals: [string, string, boolean][] = [
    ['Subtotal', '$80.00', false],
    ['Sales Tax (8.5%)', '$6.80', false],
    ['TOTAL', '$86.80', true],
  ];
  y += 50;
  for (const [label, val, bold] of totals) {
    ctx.font = bold ? 'bold 22px monospace' : '18px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, 50, y);
    ctx.textAlign = 'right';
    ctx.fillText(val, 590, y);
    y += 38;
  }
  return canvas.toDataURL('image/jpeg', 0.9);
}

export function StepCapture({
  receiptImage,
  onSetImage,
  onNext,
  loading = false,
  error = null,
}: StepCaptureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);

  const openCamera = () => {
    setNotice(null);
    if (isTouchDevice()) {
      cameraInputRef.current?.click();
      return;
    }
    const problem = mediaProblem();
    if (problem === 'insecure') {
      setNotice(insecureContextHelp('camera') + ' Choose a photo with "Upload Photo" for now.');
      return;
    }
    if (problem) {
      setNotice('Live camera is not supported in this browser. Choose a photo with "Upload Photo".');
      return;
    }
    setIsCameraOpen(true);
  };

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoadingSeconds(0);
      timer = setInterval(() => {
        setLoadingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setLoadingSeconds(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [loading]);

  const readFile = useCallback(
    async (file: File) => {
      setNotice(null);
      if (file.type && !file.type.startsWith('image/')) {
        setNotice('That file is not an image. Choose a photo of the receipt.');
        return;
      }
      try {
        const compressed = await compressReceiptImage(file);
        onSetImage(compressed);
      } catch {
        if (file.size > 8 * 1024 * 1024) {
          setNotice(
            'This photo format could not be processed and is too large to upload. Take a JPEG photo or a screenshot instead.'
          );
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const raw = reader.result as string;
          onSetImage(raw);
        };
        reader.readAsDataURL(file);
      }
    },
    [onSetImage, onNext]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) readFile(f);
    e.target.value = '';
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) readFile(f);
    },
    [readFile]
  );

  const hasInput = !!receiptImage;

  return (
    <div className="animate-fade-up space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative rounded-2xl border transition-all duration-200 ${
          isDragging
            ? 'border-[var(--brand)] bg-[var(--brand-dim)] shadow-[0_0_28px_var(--brand-glow)]'
            : receiptImage
            ? 'border-[var(--brand)]/40 bg-[var(--bg-surface)]'
            : 'border-white/10 hover:border-[var(--brand)]/35 bg-[var(--bg-surface)]/70'
        }`}
      >
        {receiptImage ? (
          /* Full Receipt Stage with Live Optical Laser Scan Overlay */
          <div className="p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--brand)]">
                <span
                  className={`w-2 h-2 rounded-full bg-[var(--brand)] ${
                    loading ? 'animate-ping' : ''
                  }`}
                />
                <span>
                  {loading
                    ? loadingSeconds > 20
                      ? `Still reading receipt (${loadingSeconds}s)...`
                      : 'Scanning receipt items and tax...'
                    : 'Receipt ready'}
                </span>
              </div>
              {!loading && (
                <button
                  type="button"
                  onClick={() => onSetImage(null)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold text-[var(--fg-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5"/>
                  <span>Remove</span>
                </button>
              )}
            </div>

            <div className="relative mx-auto max-w-[260px] sm:max-w-[280px] rounded-2xl overflow-hidden bg-black/60 border border-white/15 shadow-2xl">
              <img
                src={receiptImage}
                alt="Uploaded receipt"
                className={`w-full max-h-72 object-contain mx-auto block transition-all duration-300 ${
                  loading ? 'brightness-95 contrast-105' : ''
                }`}
              />

              <div className="pointer-events-none absolute inset-2.5">
                <span className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-[var(--brand)] rounded-tl" />
                <span className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-[var(--brand)] rounded-tr" />
                <span className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-[var(--brand)] rounded-bl" />
                <span className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-[var(--brand)] rounded-br" />
              </div>

              {loading && (
                <div className="absolute inset-0 scan-grid-overlay bg-[var(--brand)]/5 pointer-events-none">
                  <div className="scan-laser-line" />
                </div>
              )}
            </div>

            {loading && (
              <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1 animate-fade-in">
                <span className="px-2.5 py-0.5 rounded-full bg-[var(--bg-muted)] border border-white/10 text-[10px] font-semibold text-[var(--brand)]">
                  Items &amp; Quantities
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-[var(--bg-muted)] border border-white/10 text-[10px] font-semibold text-[var(--fg-secondary)]">
                  Tax &amp; Discounts
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-[var(--bg-muted)] border border-white/10 text-[10px] font-semibold text-[var(--fg-secondary)]">
                  Receipt Total
                </span>
              </div>
            )}
          </div>
        ) : (
          /* Clean Empty Drop State */
          <div className="p-6 sm:p-10 text-center space-y-5">
            {/* Receipt Icon with Top-Right Emerging "Try sample" Badge */}
            <div className="relative w-14 h-14 mx-auto flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-[var(--brand-dim)] border border-[var(--brand)]/30 flex items-center justify-center text-[var(--brand)] shadow-[0_0_20px_var(--brand-glow)]">
                <Receipt className="w-5 h-5"/>
              </div>

              <button
                type="button"
                onClick={() => {
                  const sampleUrl = generateSampleReceiptDataUrl();
                  if (sampleUrl) {
                    onSetImage(sampleUrl, true);
                  }
                }}
                className="sample-pop-badge absolute -top-2.5 left-9 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--bg-card)] hover:bg-[var(--brand)] text-[var(--brand)] hover:text-[#1b1418] border border-[var(--brand)]/45 shadow-[0_0_18px_rgba(255,217,180,0.28)] hover:shadow-[0_0_24px_rgba(255,217,180,0.5)] text-[10px] font-bold tracking-wide whitespace-nowrap transition-colors cursor-pointer"
                title="Load a sample receipt to test the full flow"
              >
                <span>Try sample</span>
                <ArrowUpRight className="w-3 h-3 stroke-[2.5]"/>
              </button>
            </div>

            <div className="space-y-1.5">
              <p className="text-base sm:text-lg font-semibold text-[var(--fg-primary)]">
                Add your receipt
              </p>
              <p className="text-xs sm:text-sm text-[var(--fg-muted)] max-w-sm mx-auto">
                Take a photo or drop an image from any restaurant, grocery store, or cafe.
              </p>
            </div>

            {/* Same horizontal line on both mobile and desktop */}
            <div className="grid grid-cols-2 sm:flex sm:flex-row items-center justify-center gap-2.5 pt-1 max-w-xs sm:max-w-none mx-auto">
              <Button icon={<Camera className="w-4 h-4" />} size="md" variant="primary" onClick={openCamera} className="w-full sm:w-auto px-3 sm:px-5 text-xs sm:text-sm">
                Open Camera
              </Button>
              <Button icon={<Upload className="w-4 h-4" />} size="md" variant="secondary" onClick={() => fileInputRef.current?.click()} className="w-full sm:w-auto px-3 sm:px-5 text-xs sm:text-sm">
                Upload Photo
              </Button>
            </div>

            <div className="pt-1 flex items-center justify-center">
              <p className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--bg-muted)]/75 border border-white/8 text-[11px]">
                <span className="portal-shine-text font-medium">
                  You can upload multiple receipts
                </span>
                <span className="text-white/20">|</span>
                <span className="mono text-[10px] font-bold uppercase tracking-wider text-[var(--brand)]">
                  Soon
                </span>
              </p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {(notice || error) && (
        <div
          role="alert"
          className="p-3 rounded-xl border border-[var(--brand)]/20 bg-[var(--brand)]/10 text-xs font-semibold text-[var(--brand-light)] leading-relaxed"
        >
          {notice || error}
        </div>
      )}

      <CameraModal isOpen={isCameraOpen} onClose={() => setIsCameraOpen(false)}
        onCapture={(img) => {
          onSetImage(img);
        }}
      />

      {hasInput && (
        <Button className="w-full" disabled={loading || !hasInput} loading={loading}
          size="lg"
          variant="primary"
          onClick={() => onNext()}
        >
          {loading ? 'Still reading receipt...' : 'Scan Receipt'}
        </Button>
      )}
    </div>
  );
}

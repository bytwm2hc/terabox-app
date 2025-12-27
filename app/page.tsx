"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// --- 常量定義 ---
const TERABOX_DOMAINS = [
  "mirrobox", "nephobox", "freeterabox", "1024tera", "4funbox",
  "terabox", "teraboxapp", "momerybox", "tibibox", "terabox.fun"
];
const TERABOX_REGEX = new RegExp(`(${TERABOX_DOMAINS.join("|")})\\.(com|co|app|fun|ap)`, "i");

const fetcher = async (url: string) => {
  const res = await fetch(url);
  // 明確宣告 json 的類型為 any，或是自定義介面
  const json = (await res.json()) as { error?: string; [key: string]: any };
  
  if (!res.ok) {
    throw new Error(json.error || "解析失敗，請確認連結有效性");
  }
  return json;
};

export default function Home() {
  const [inputValue, setInputValue] = useState("");
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState("");

  const { data, error, isValidating, mutate } = useSWR(
    token ? `/api?data=${encodeURIComponent(token)}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    }
  );

  const handleAction = useCallback(async () => {
    setLocalError("");
    if (!inputValue.trim()) {
      setLocalError("請先輸入連結");
      return;
    }
    if (!TERABOX_REGEX.test(inputValue)) {
      setLocalError("連結格式不正確");
      return;
    }

    if (inputValue === token) {
      mutate();
    } else {
      setToken(inputValue);
    }
  }, [inputValue, token, mutate]);

  useEffect(() => {
    if (data?.file_name) document.title = data.file_name;
  }, [data]);

  useEffect(() => {
    if (localError || error) {
      const timer = setTimeout(() => setLocalError(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [localError, error]);

  const isLoading = isValidating;
  const currentError = localError || (error as Error)?.message;

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-200 font-sans">
      {/* 1. 導覽列：修正 Hover 配色 */}
      <nav className="border-b border-slate-800 bg-[#0f172a]/95 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="text-lg sm:text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent whitespace-nowrap">
            Terabox Downloader
          </Link>
          <div className="flex items-center gap-2 sm:gap-4">
            <Button 
              variant="ghost" 
              size="sm" 
              asChild 
              className="hidden sm:inline-flex text-slate-400 hover:bg-slate-800 hover:text-blue-400 transition-colors whitespace-nowrap"
            >
              <Link href="https://github.com/r0ld3x/terabox-app" target="_blank">Github</Link>
            </Button>
            <Button 
              size="sm" 
              className="bg-blue-600 hover:bg-blue-500 text-white shadow-md whitespace-nowrap px-4"
              asChild
            >
              <Link href="https://t.me/RoldexVerse" target="_blank">Telegram</Link>
            </Button>
          </div>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-12 md:py-20">
        {/* 2. 輸入區域：解決按鈕折行 */}
        <section className="bg-slate-800/40 rounded-[2rem] p-6 md:p-12 border border-slate-700/50 shadow-2xl mb-12">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <h1 className="text-3xl md:text-5xl font-black text-white mb-6 tracking-tight leading-tight">
              解析下載連結
            </h1>
            <p className="text-slate-400 text-base md:text-lg leading-relaxed">
              貼上您的連結，剩下的交給我們。
            </p>
          </div>

          <div className="max-w-2xl mx-auto">
            <div className="flex flex-col sm:flex-row items-stretch gap-3">
              <div className="flex-1">
                <Input
                  className="h-14 bg-slate-900/60 border-slate-700 text-white rounded-2xl px-6 focus:ring-2 focus:ring-blue-500 transition-all text-base w-full"
                  placeholder="在此貼上連結..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAction()}
                  disabled={isLoading}
                />
              </div>
              <Button 
                onClick={handleAction}
                disabled={isLoading}
                // 使用 whitespace-nowrap 防止文字折行，w-full sm:w-auto 確保手機版滿寬但電腦版自適應
                className="h-14 px-8 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all active:scale-95 whitespace-nowrap w-full sm:w-auto flex-shrink-0"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    正在解析
                  </span>
                ) : "開始解析"}
              </Button>
            </div>

            {currentError && (
              <div className="mt-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl text-rose-400 text-sm text-center animate-in fade-in zoom-in duration-300">
                {currentError}
              </div>
            )}
          </div>
        </section>

        {/* 3. 解析結果：優化排版 */}
        {data && (
          <section className="bg-slate-800/60 rounded-[2rem] p-6 md:p-10 border border-blue-500/20 shadow-xl animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="flex flex-col md:flex-row gap-10 items-center md:items-start">
              {data.thumb && (
                <div className="relative shrink-0 w-48 h-48 overflow-hidden rounded-3xl border border-slate-700 bg-slate-900 group shadow-inner">
                  <Image
                    className="object-contain p-2 transition duration-700 group-hover:scale-110 blur-md hover:blur-none"
                    src={data.thumb}
                    fill
                    alt="file thumbnail"
                  />
                </div>
              )}

              <div className="flex-1 w-full flex flex-col justify-between min-h-[12rem] text-center md:text-left">
                <div className="space-y-4">
                  <div>
                    <span className="inline-block px-3 py-1 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-bold uppercase tracking-widest mb-3">
                      File Name
                    </span>
                    <h2 className="text-xl md:text-2xl font-bold text-white break-all leading-snug">
                      {data.file_name}
                    </h2>
                  </div>
                  <div>
                    <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-bold uppercase tracking-widest mb-3">
                      File Size
                    </span>
                    <p className="text-3xl font-mono font-black text-emerald-400 leading-none">{data.size}</p>
                  </div>
                </div>

                <div className="pt-8">
                  <Button asChild className="w-full md:w-auto h-14 px-12 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-lg rounded-2xl shadow-lg shadow-emerald-900/20 transition-all hover:-translate-y-1 whitespace-nowrap">
                    <a href={data.direct_link} target="_blank" rel="noopener noreferrer">
                      立即下載檔案
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
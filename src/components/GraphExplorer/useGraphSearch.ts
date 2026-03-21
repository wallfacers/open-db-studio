import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GraphNode } from './useGraphData';

interface UseGraphSearchResult {
  keyword: string;
  setKeyword: (kw: string) => void;
  results: GraphNode[];
  loading: boolean;
  searched: boolean;
}

export function useGraphSearch(connectionId: number | null): UseGraphSearchResult {
  const [keyword, setKeywordState] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setKeyword = useCallback((kw: string) => {
    setKeywordState(kw);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!kw.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }

    if (connectionId === null) return;

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await invoke<GraphNode[]>('search_graph', {
          connectionId,
          keyword: kw.trim(),
        });
        setResults(res);
        setSearched(true);
      } catch {
        setResults([]);
        setSearched(true);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [connectionId]);

  return { keyword, setKeyword, results, loading, searched };
}

// Faceted categorisation hook for the Plugins home section.
//
// Two-level starter model: the top row is the artifact kind
// (Prototype / Slides / Image / Video / HyperFrames / Audio). Prototype,
// Slides, Image, and Video expose scene buckets from the prompt-taxonomy
// analysis; HyperFrames and Audio stay flat.
//
// A small "Saved" toggle sits orthogonally to the category row —
// when active it overrides the category selection and just shows
// the plugins saved by the user. We intentionally make Saved
// override rather than AND-compose so a saved pick is never
// accidentally hidden behind a still-selected category pill.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  applyFacetSelection,
  buildFacetCatalog,
  filterByQuery,
  resolveDefaultSelection,
  type FacetCatalog,
  type FacetSelection,
} from './facets';
import { sortByVisualAppeal } from './visualScore';

export type FilterMode = 'all' | 'saved' | 'iux';

interface UsePluginFacetsArgs {
  plugins: InstalledPluginRecord[];
  savedPluginIds?: ReadonlySet<string>;
  preferDefaultFacet?: boolean;
  // External selection driven by the Home hero chip rail. When this
  // value changes to a new (non-null) selection, the hook applies it,
  // overriding both the user's manual pick and the default-facet
  // bootstrap. We track the last-applied identity so the user can
  // still click a different category afterwards without the effect
  // snapping back on every re-render.
  presetSelection?: FacetSelection | null;
}

export interface UsePluginFacetsResult {
  visiblePlugins: InstalledPluginRecord[];
  savedList: InstalledPluginRecord[];
  filtered: InstalledPluginRecord[];
  catalog: FacetCatalog;
  selection: FacetSelection;
  pickCategory: (slug: string | null) => void;
  pickSubcategory: (slug: string | null) => void;
  clearFacets: () => void;
  hasActiveFacet: boolean;
  mode: FilterMode;
  setMode: (next: FilterMode) => void;
  query: string;
  setQuery: (next: string) => void;
  totalVisible: number;
}

const EMPTY_SELECTION: FacetSelection = {
  category: null,
  subcategory: null,
};

export function usePluginFacets({
  plugins,
  savedPluginIds,
  preferDefaultFacet = true,
  presetSelection = null,
}: UsePluginFacetsArgs): UsePluginFacetsResult {
  const [mode, setMode] = useState<FilterMode>('iux');
  const [selection, setSelection] = useState<FacetSelection>(EMPTY_SELECTION);
  const [query, setQuery] = useState('');
  // Apply the preferred default selection once, on the first render that
  // sees a non-empty catalog. Using a flag (instead of a useState lazy
  // initializer) handles the realistic case where `args.plugins` is
  // empty at first paint and arrives a tick later.
  const [bootstrapped, setBootstrapped] = useState(false);
  const lastAppliedPresetKeyRef = useRef<string | null>(null);

  // Atoms are infrastructure pieces (`code-import`, `patch-edit`) that
  // are not user-facing on the home grid; the original section already
  // filtered them out and we preserve that contract. We immediately
  // sort by visual-appeal score so the first viewport leads with the
  // cinematic decks / image / video templates rather than alphabetical
  // bundled noise. Featured plugins get a +1000 score boost inside the
  // sort so curator picks stay anchored to the front of every category view.
  const visiblePlugins = useMemo(
    () =>
      sortByVisualAppeal(
        plugins.filter((p) => p.manifest?.od?.kind !== 'atom'),
      ),
    [plugins],
  );

  const savedList = useMemo(
    () => visiblePlugins.filter((plugin) => savedPluginIds?.has(plugin.id)),
    [savedPluginIds, visiblePlugins],
  );

  const catalog = useMemo(() => buildFacetCatalog(visiblePlugins), [visiblePlugins]);

  useEffect(() => {
    if (bootstrapped) return;
    if (visiblePlugins.length === 0) return;
    if (!preferDefaultFacet) {
      setBootstrapped(true);
      return;
    }
    const next = resolveDefaultSelection(catalog);
    if (next.category !== null) {
      setSelection(next);
    }
    setBootstrapped(true);
  }, [bootstrapped, preferDefaultFacet, visiblePlugins.length, catalog]);

  // Sync an externally-driven selection (the Home chip rail) into the
  // facet state. We only apply a preset once per identity so the user
  // can still click a different facet pill afterwards without the
  // effect snapping back. Setting `bootstrapped` here also prevents
  // the default-facet effect above from overriding the preset on the
  // first non-empty render.
  useEffect(() => {
    if (!presetSelection) return;
    const key = `${presetSelection.category ?? ''}::${presetSelection.subcategory ?? ''}`;
    if (lastAppliedPresetKeyRef.current === key) return;
    lastAppliedPresetKeyRef.current = key;
    setSelection(presetSelection);
    setMode((current) => (current === 'saved' ? 'all' : current));
    setBootstrapped(true);
  }, [presetSelection]);

  // The visual-appeal sort is applied at `visiblePlugins` derivation
  // (above), so any downstream `applyFacetSelection` slice preserves
  // the ranking. We do not re-sort here because filter + featured
  // override should both remain stable across selections.
  const filtered = useMemo(() => {
    let base:any =
      mode === 'saved'
        ? savedList
        :
        mode === 'iux'
          ? savedList
          : applyFacetSelection(visiblePlugins, selection);
    if (mode === 'iux') {
      base = [
        {
          "id": "example-magazine-poster",
          "title": "Magazine Poster",
          "version": "0.1.0",
          "sourceKind": "bundled",
          "source": "E:\\workspace\\proj\\github\\ypvichi\\open-design\\plugins\\_official\\examples\\magazine-poster",
          "sourceMarketplaceId": "iux",
          "sourceMarketplaceEntryName": "open-design/example-magazine-poster",
          "sourceMarketplaceEntryVersion": "0.1.0",
          "marketplaceTrust": "iux",
          "resolvedSource": "E:\\workspace\\proj\\github\\ypvichi\\open-design\\plugins\\_official\\examples\\magazine-poster",
          "trust": "bundled",
          "capabilitiesGranted": [
            "prompt:inject"
          ],
          "manifest": {
            "specVersion": "1.0.0",
            "$schema": "https://open-design.ai/schemas/plugin.v1.json",
            "name": "example-magazine-poster",
            "title": "Magazine Poster",
            "version": "0.1.0",
            "description": "An editorial-style poster — newsprint paper, dateline, oversized serif\nheadline with a struck-through word and italic accent, a 2-column body\nblock, and 6 numbered sections with annotated pull-quote captions.\nReads like a Sunday-paper full-page essay or a thoughtful launch poster.\nUse when the brief asks for \"magazine poster\", \"editorial poster\",\n\"newsprint\", \"essay layout\", or \"manifesto\".",
            "author": {
              "name": '',//"Open Design",
              "url": ''//"https://github.com/nexu-io"
            },
            "license": "MIT",
            "homepage": '',//"https://github.com/nexu-io/open-design/tree/main/plugins/_official/examples/magazine-poster",
            "tags": [
              // "example",
              // "first-party",
              "prototype",
              // "marketing",
              "web",
              "desktop",
              // "magazine-poster",
              // "editorial-poster",
              // "newsprint",
              // "newspaper-layout",
              // "essay",
              // "manifesto",
              // "long-form-poster",
              // "untitled"
            ],
            "compat": {
              "agentSkills": [
                {
                  "path": "./SKILL.md"
                }
              ]
            },
            "od": {
              "kind": "scenario",
              "taskKind": "new-generation",
              "mode": "prototype",
              "platform": "desktop",
              "scenario": "marketing",
              "preview": {
                "type": "html",
                "entry": "./example.html"
              },
              "useCase": {
                "query": {
                  "en": "Use this plugin to: Design an HTML prototype page.",//"Design an editorial magazine-style poster — ‘You don't need a designer to ship your first draft anymore.’ Newsprint paper, six numbered sections.",
                  "zh-CN": "请用这个插件完成以下任务：设计一个HTML原型页面"//"使用这个插件完成以下任务：Design an editorial magazine-style poster — ‘You don't need a designer to ship your first draft anymore.’ Newsprint paper, six numbered sections."
                },
                "exampleOutputs": [
                  {
                    "path": "./example.html",
                    "title": "IUX页面模板"
                  }
                ]
              },
              "context": {
                "skills": [
                  {
                    "path": "./SKILL.md"
                  }
                ],
                "designSystem": {
                  "primary": true
                },
                "assets": [
                  "./example.html"
                ]
              },
              "pipeline": {
                "stages": [
                  {
                    "id": "generate",
                    "atoms": [
                      "file-write",
                      "live-artifact"
                    ]
                  }
                ]
              },
              "capabilities": [
                "prompt:inject",
                "fs:write"
              ],
              "surface": "web",
              "featured": 0.02
            }
          },
          "fsPath": "E:\\workspace\\proj\\github\\ypvichi\\open-design\\plugins\\_official\\examples\\magazine-poster",
          "installedAt": 1779414077731,
          "updatedAt": 1783936344415
        }
      ];
    }
    return filterByQuery(base, query);
  }, [mode, savedList, visiblePlugins, selection, query]);

  function pickCategory(slug: string | null): void {
    if (mode !== 'all') setMode('all');
    setSelection((prev) => ({
      category: prev.category === slug ? null : slug,
      subcategory: null,
    }));
  }

  function pickSubcategory(slug: string | null): void {
    if (mode === 'saved') setMode('all');
    setSelection((prev) => ({
      ...prev,
      subcategory: prev.subcategory === slug ? null : slug,
    }));
  }

  function clearFacets(): void {
    setSelection(EMPTY_SELECTION);
    setQuery('');
    // Saved overrides the facet slice, so the empty-state "Clear
    // filters" CTA also has to leave Saved mode — otherwise clicking
    // it from a Saved + zero-match view just re-renders the same
    // empty state and the user has no one-click escape back to the
    // full catalog.
    setMode('all');
  }

  const hasActiveFacet =
    selection.category !== null || selection.subcategory !== null || query.trim().length > 0;

  return {
    visiblePlugins,
    savedList,
    filtered,
    catalog,
    selection,
    pickCategory,
    pickSubcategory,
    clearFacets,
    hasActiveFacet,
    mode,
    setMode,
    query,
    setQuery,
    totalVisible: visiblePlugins.length,
  };
}

import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { navigate } from "../../shared/state/router.ts";
import { Group } from "../../shared/ui/index.ts";

/**
 * The way back up from code: the features a file or function belongs to, and the steps of
 * each feature's flow that run through it. Hidden until there is a feature map.
 */
export function PartOf({ file, symbol }: { file: string; symbol?: string }) {
  const { data } = useQuery(`part-of:${file}:${symbol ?? ""}`, () => api.partOf(file, symbol));
  if (!data?.features.length) return null;
  return (
    <Group id="part-of" title="Part of" count={data.features.length} open>
      {data.features.map((f) => (
        <div key={f.id} className="part-of">
          <button className="row" onClick={() => navigate({ view: "feature", id: f.id })}>
            <span className="part-of-dot" data-kind={f.kind} aria-hidden="true" />
            <span className="grow">{f.name}</span>
            <span className="sub">{f.kind === "shared" ? "shared" : f.steps.length ? `${f.steps.length} step${f.steps.length > 1 ? "s" : ""}` : ""}</span>
          </button>
          {f.steps.map((s) => (
            <button key={s.index} className="row part-of-step" onClick={() => navigate({ view: "feature", id: f.id })}>
              <span className="step-n">{s.index}</span>
              <span className="grow">{s.step}</span>
            </button>
          ))}
        </div>
      ))}
    </Group>
  );
}

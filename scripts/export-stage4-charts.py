"""Export submission PNGs from the public, aggregate-only Stage 4 report.

Run with Python 3.12 and scripts/stage4-plot-requirements.txt installed, or put
those packages in the ignored .cache/stage4-plotting directory. No model client,
environment file, private checkpoint or network connection is used here.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "stage4-plotting"
if CACHE.is_dir():
    sys.path.insert(0, str(CACHE))
MPL_CACHE = ROOT / ".cache" / "stage4-matplotlib"
MPL_CACHE.mkdir(parents=True, exist_ok=True)
os.environ["MPLCONFIGDIR"] = str(MPL_CACHE)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
import numpy as np

BG, INK, MUTED, GRID = "#F7F9FC", "#15263E", "#65758B", "#E0E7F0"
BLUE, TEAL, GRAY = "#0866FF", "#167D83", "#8A9BB3"
MODEL_COLORS = [BLUE, GRAY, TEAL]
PLOT_SIZE = (19.2, 10.8)
DPI = 100
PROVIDERS = [("gemini", "Gemini"), ("muse-spark", "Muse Spark")]
MAIN_SLICES = ["company-single", "company-multi", "company-arithmetic", "knowledge", "gpqa"]
COST_SLICES = MAIN_SLICES + ["other", "overall"]
SHORT_LABELS = {
    "company": "Company data",
    "company-single": "Company · single document",
    "company-multi": "Company · multi-document",
    "company-arithmetic": "Company · arithmetic*",
    "knowledge": "General knowledge",
    "gpqa": "GPQA · hard questions",
    "other": "Other task categories",
    "overall": "Full saved workload",
}


def number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def validate_report(report):
    if report.get("cloudCalls") != 0 or report.get("spendUsd") != 0:
        raise ValueError("PNG export requires the recorded zero-cloud, zero-spend Stage 4 report")
    if report.get("primaryPopulation") != "frozen-saved60":
        raise ValueError("The submission charts require the independent saved60 replay, not pooled dev/test data")
    if not isinstance(report.get("runId"), str) or not report.get("models"):
        raise ValueError("Report identity and separate model metadata are required")
    if not isinstance(report.get("rows"), list) or not isinstance(report.get("costs"), list):
        raise ValueError("Missing per-model aggregate measurements")
    for row in report["rows"]:
        for field in ["acceptanceRate", "acceptedAccuracy", "escalationRate"]:
            if row.get(field) is not None and (not number(row[field]) or not 0 <= row[field] <= 1):
                raise ValueError(f"Invalid aggregate probability: {field}")
        bounds = row.get("acceptedAccuracyWilson95")
        if bounds is not None and (not isinstance(bounds, list) or len(bounds) != 2 or not all(number(x) and 0 <= x <= 1 for x in bounds) or bounds[0] > bounds[1]):
            raise ValueError("Invalid Wilson sensitivity interval")
        if row.get("accepted") == 0 and (row.get("acceptedAccuracy") is not None or bounds is not None):
            raise ValueError("Zero acceptance cannot be drawn as measured 100% accuracy")
    for row in report.get("privacy", []):
        if row.get("actualCloudCalls") != 0 or row.get("actualCompanyCloudCalls") != 0 or row.get("actualBusinessCloudCalls") != 0:
            raise ValueError("Privacy chart cannot claim this offline study delivered data to a cloud")
    return report


def primary_rows(report, key):
    return [row for row in report.get(key, []) if row.get("population") == report["primaryPopulation"]]


def find(rows, **conditions):
    matches = [row for row in rows if all(row.get(key) == value for key, value in conditions.items())]
    if len(matches) > 1:
        raise ValueError("Duplicate aggregate identity in chart source")
    return matches[0] if matches else None


def model_label(model):
    return model.get("label", model["id"])


def format_percent(value):
    return f"{value * 100:.1f}%" if number(value) else "pending"


def format_money(value):
    return f"${value:.4f}" if number(value) else "pending"


def canvas(title, subtitle):
    fig = plt.figure(figsize=PLOT_SIZE, dpi=DPI, facecolor=BG)
    fig.text(.055, .95, "HANDOFF  /  PRIVATE AI GATEWAY", fontsize=13, fontweight="bold", color=BLUE)
    fig.text(.055, .895, title, fontsize=29, fontweight="bold", color=INK)
    fig.text(.055, .855, subtitle, fontsize=14, color=MUTED)
    return fig


def style_axis(ax, xgrid=True):
    ax.set_facecolor(BG)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis="both", colors=MUTED, length=0, pad=10, labelsize=12)
    ax.set_axisbelow(True)
    if xgrid:
        ax.grid(axis="x", color=GRID, linewidth=.8)


def footer(fig, first, second):
    fig.text(.055, .075, first, fontsize=11.5, color=MUTED)
    fig.text(.055, .045, second, fontsize=11.5, color=MUTED)


def save(fig, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(destination, dpi=DPI, facecolor=BG, metadata={"Software": "Handoff aggregate chart exporter", "Description": "Tier 0; no cloud calls; saved frozen replay"})
    plt.close(fig)


def export_local(report, target):
    rows, models = primary_rows(report, "rows"), report["models"]
    fig = canvas("Local acceptance, quality and latency", "Same saved questions. Separate models. Every accepted company claim requires validated local evidence.")
    grid = fig.add_gridspec(1, 3, left=.215, right=.94, top=.775, bottom=.23, width_ratios=[1.1, 1.2, 1], wspace=.20)
    axs = [fig.add_subplot(grid[0, i]) for i in range(3)]
    ys = np.arange(len(MAIN_SLICES)) * 1.35
    offsets = np.linspace(-.26, .26, len(models))
    max_latency = max([row.get("medianLatencyMs") or 0 for row in rows if row.get("sliceId") in MAIN_SLICES] + [1])
    for index, model in enumerate(models):
        color = MODEL_COLORS[index % len(MODEL_COLORS)]
        for y, slice_id in zip(ys, MAIN_SLICES):
            row = find(rows, modelId=model["id"], sliceId=slice_id)
            pos = y + offsets[index]
            if not row or not row.get("items"):
                continue
            rate = row.get("acceptanceRate")
            if number(rate):
                axs[0].barh(pos, rate * 100, height=.205, color=color, alpha=.95, zorder=3)
                axs[0].plot(0, pos, "|", color=color, markersize=9, zorder=4)
                axs[0].text(rate * 100 + 2, pos, f"{row['accepted']}/{row['items']}", va="center", fontsize=10, color=color)
            point, bounds = row.get("acceptedAccuracy"), row.get("acceptedAccuracyWilson95")
            if number(point) and bounds:
                axs[1].errorbar(point * 100, pos, xerr=[[max(0, point-bounds[0])*100], [max(0, bounds[1]-point)*100]], fmt="o", markersize=7, color=color, capsize=4, linewidth=2, zorder=3)
                axs[1].text(104, pos, f"{row['acceptedCorrect']}/{row['accepted']}", va="center", color=color, fontsize=10)
            else:
                axs[1].text(50, pos, "—", ha="center", va="center", color=color, fontsize=12)
            latency = row.get("medianLatencyMs")
            if number(latency):
                axs[2].barh(pos, latency, height=.205, color=color, zorder=3)
                axs[2].text(latency + max_latency * .025, pos, f"{latency:,.0f}", va="center", fontsize=10, color=color)
    labels = [SHORT_LABELS[key] for key in MAIN_SLICES]
    for i, ax in enumerate(axs):
        style_axis(ax)
        ax.set_ylim(ys[-1] + .65, -.65)
        ax.set_yticks(ys, labels if i == 0 else [])
        ax.set_title(["Accepted locally", "Accepted full credit + Wilson 95%", "Median local path latency"][i], color=INK, loc="left", fontsize=14, pad=19, fontweight="bold")
    axs[0].set_xlim(0, 119)
    axs[0].set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
    axs[1].set_xlim(0, 125)
    axs[1].set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
    axs[2].set_xlim(0, max_latency * 1.30)
    axs[2].set_xlabel("Milliseconds · local steps only", color=MUTED, fontsize=11)
    handles = [Patch(color=MODEL_COLORS[i % 3], label=model_label(model)) for i, model in enumerate(models)]
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(.56, .135), ncol=len(models), frameon=False, fontsize=13)
    gpqa = find(rows, modelId=models[0]["id"], sliceId="gpqa")
    gpqa_n = gpqa.get("items", 0) if gpqa else 0
    footer(fig, "*Arithmetic overlaps single- and multi-document company slices. — = no accepted answers. GPQA sample: n=" + str(gpqa_n) + "; no broad hard-question claim.", "Frozen saved60. Wilson intervals assume IID items and are sensitivity, not certification. Future accuracy is uncertified. Cloud latency is unmeasured.")
    save(fig, target / "local-acceptance-quality.png")


def export_costs(report, target):
    rows, models = primary_rows(report, "costs"), report["models"]
    fig = canvas("Lower cloud fees for company questions", "Projected fees per 1,000 questions · matched all-cloud baseline · local hardware allocation excluded")
    grid = fig.add_gridspec(1, 2, left=.205, right=.94, top=.78, bottom=.21, wspace=.18)
    ys = np.arange(len(COST_SLICES)) * 1.25
    offsets = np.linspace(-.27, .27, len(models))
    for panel, (provider, label) in enumerate(PROVIDERS):
        ax = fig.add_subplot(grid[0, panel])
        for index, model in enumerate(models):
            color = MODEL_COLORS[index % 3]
            for y, slice_id in zip(ys, COST_SLICES):
                row = find(rows, modelId=model["id"], sliceId=slice_id, cloudId=provider)
                if not row or not number(row.get("costPer1000")) or not number(row.get("cloudOnlyPer1000")):
                    continue
                pos = y + offsets[index]
                ax.barh(pos, row["cloudOnlyPer1000"], height=.20, color="#DFE6EF", zorder=2)
                ax.barh(pos, row["costPer1000"], height=.20, color=color, zorder=3)
                ax.plot(row["cloudOnlyPer1000"], pos, "|", color=INK, markersize=10, zorder=4)
        values = [row.get("cloudOnlyPer1000") or 0 for row in rows if row.get("cloudId") == provider and row.get("sliceId") in COST_SLICES]
        style_axis(ax)
        ax.set_ylim(ys[-1] + .65, -.65)
        ax.set_yticks(ys, [SHORT_LABELS[key] for key in COST_SLICES] if panel == 0 else [])
        ax.set_xlim(0, max(values + [1e-4]) * 1.12)
        ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda value, _: f"${value:.2f}"))
        ax.set_title(label, loc="left", color=INK, fontsize=20, pad=18, fontweight="bold")
    handles = [Patch(color=MODEL_COLORS[i % 3], label=model_label(model)) for i, model in enumerate(models)] + [Line2D([], [], marker="|", linestyle="None", color=INK, markersize=14, label="Matched all-cloud baseline")]
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(.56, .125), ncol=4, frameon=False, fontsize=12)
    footer(fig, "Assumptions: unit prices and projected output lengths. Inputs counted offline: Gemini SDK tokenizer; labelled Muse Spark Llama proxy.", "Frozen saved60. Identical lean payloads, no drafts; minimal redacted context may be included. *Arithmetic overlaps company slices. Actual cloud spend: " + format_money(report["spendUsd"]) + ".")
    save(fig, target / "cloud-costs-by-slice.png")


def export_workload(report, target):
    model_id = report.get("recommendation", {}).get("modelId")
    if not model_id:
        raise ValueError("Workload chart requires the report's explicit model recommendation")
    model = next((model for model in report["models"] if model["id"] == model_id), None)
    if model is None:
        raise ValueError("Recommended model is absent from the separate model metadata")
    rows = [row for row in report.get("workloadMix", []) if row.get("population") == report["primaryPopulation"] and row.get("modelId") == model_id]
    fig = canvas("More questions over company documents", model_label(model) + " company policy · other safe questions escalate · adversarial items stay local")
    grid = fig.add_gridspec(1, 2, left=.085, right=.94, top=.77, bottom=.23, wspace=.22)
    for panel, (provider, label) in enumerate(PROVIDERS):
        ax = fig.add_subplot(grid[0, panel])
        selected = sorted([row for row in rows if row.get("cloudId") == provider], key=lambda row: row["companyShare"])
        if len(selected) != 3:
            raise ValueError("Workload scenarios must contain the predeclared 25%, 50% and 75% company shares")
        xs = [row["companyShare"] * 100 for row in selected]
        costs = [row["costPer1000"] for row in selected]
        baselines = [row["cloudOnlyPer1000"] for row in selected]
        ax.plot(xs, baselines, color=GRAY, linestyle="--", linewidth=2.5, marker="o", markersize=7, label="Matched all-cloud")
        ax.plot(xs, costs, color=BLUE, linewidth=3, marker="o", markersize=9, label="Handoff")
        ax.fill_between(xs, costs, baselines, color=BLUE, alpha=.08)
        for x, row in zip(xs, selected):
            ax.annotate(f"{format_money(row['savingPer1000'])} saved\n{format_percent(row['savingRate'])}", (x, row["costPer1000"]), xytext=(0, -46), textcoords="offset points", ha="center", va="top", color=TEAL, fontsize=13, fontweight="bold")
        style_axis(ax)
        ax.grid(axis="y", color=GRID, linewidth=.8)
        ax.set_xticks([25, 50, 75], ["25% company docs", "50% company docs", "75% company docs"])
        ax.set_xlim(18, 82)
        ax.set_ylim(0, max(baselines) * 1.2)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda value, _: f"${value:.2f}"))
        ax.set_ylabel("Projected cloud fees per 1,000 total queries", color=MUTED, fontsize=12)
        ax.set_title(label, loc="left", color=INK, fontsize=20, pad=18, fontweight="bold")
        ax.legend(frameon=False, loc="upper right", fontsize=12)
    risk = report.get("certification", {}).get("finiteDevUpperRisk")
    risk_label = f"{risk * 100:.2f}% finite-dev bound" if number(risk) else "Finite-dev bound pending"
    footer(fig, "Scenario projection from the saved slice mix; this is not a new benchmark or a cloud-quality measurement. Prices and outputs are assumptions.", risk_label + " covers the fixed accepted dev frame only. Future traffic is uncertified. Actual cloud calls: " + str(report["cloudCalls"]) + ". Actual cloud spend: " + format_money(report["spendUsd"]) + ".")
    save(fig, target / "company-workload-savings.png")


def export_privacy(report, target):
    models = report["models"]
    rows = primary_rows(report, "privacy")
    fig = canvas("Business data stays on the local side of the boundary", "Company documents + synthetic ad exports · proposed handoffs are redacted payloads, not completed cloud deliveries")
    grid = fig.add_gridspec(1, 2, left=.11, right=.94, top=.75, bottom=.25, width_ratios=[1.7, 1], wspace=.3)
    ax = fig.add_subplot(grid[0, 0])
    positions = np.arange(len(models))
    locals_, proposed, actual = [], [], []
    for model in models:
        row = find(rows, modelId=model["id"])
        if row is None:
            raise ValueError("Every model needs separately measured privacy aggregates")
        if row["fullyLocalBusinessDataQueries"] + row["proposedBusinessHandoffs"] != row["businessDataQueries"]:
            raise ValueError("Privacy local/proposed partition must cover the company workload")
        if row["documentCompanyQueries"] + row["adPrivacyQueries"] != row["businessDataQueries"]:
            raise ValueError("Privacy business data must include documents and ad exports without double counting")
        locals_.append(row["fullyLocalBusinessDataQueries"])
        proposed.append(row["proposedBusinessHandoffs"])
        actual.append(row["actualBusinessCloudCalls"])
    ax.barh(positions, locals_, height=.45, color=BLUE, label="Answered fully locally")
    ax.barh(positions, proposed, left=locals_, height=.45, color="#CCD7E6", label="Proposed redacted handoff · deferred")
    for y, local, handoff in zip(positions, locals_, proposed):
        if local:
            ax.text(local / 2, y, str(local), ha="center", va="center", color="white", fontsize=20, fontweight="bold")
        if handoff:
            ax.text(local + handoff / 2, y, str(handoff), ha="center", va="center", color=INK, fontsize=20, fontweight="bold")
    style_axis(ax)
    ax.set_yticks(positions, [model_label(model) for model in models], fontsize=14)
    ax.invert_yaxis()
    reference = find(rows, modelId=models[0]["id"])
    ax.set_xlabel(f"Business-data queries · {reference['documentCompanyQueries']} company-document + {reference['adPrivacyQueries']} ad-export queries per model", color=MUTED, fontsize=12, labelpad=18)
    ax.set_title("Local completion vs proposed handoff", loc="left", color=INK, fontsize=19, pad=25, fontweight="bold")
    ax.set_xlim(0, max(np.array(locals_) + np.array(proposed)) * 1.05)
    ax.xaxis.set_major_locator(plt.MaxNLocator(integer=True))
    ax.legend(loc="lower left", bbox_to_anchor=(-.04, -.35), ncol=1, frameon=False, fontsize=13)
    info = fig.add_subplot(grid[0, 1])
    info.axis("off")
    info.text(0, .93, "ACTUALLY SENT TO CLOUD", fontsize=13, fontweight="bold", color=MUTED)
    info.text(0, .69, f"{report['cloudCalls']:,} queries", fontsize=42, fontweight="bold", color=BLUE)
    info.text(0, .53, "Every model · " + format_money(report["spendUsd"]) + " cloud spend", fontsize=17, color=INK)
    info.text(0, .35, "Proposed payloads: no local drafts\nOnly redacted questions + minimum context", fontsize=15, color=INK, linespacing=1.7)
    info.text(0, .07, "Guard screening / cloud return checks:\npending in this offline replay", fontsize=14, color=MUTED, linespacing=1.7)
    footer(fig, "Question-only means no local answer draft; it does not mean that every payload omits retrieved context. Company queries may contain minimal chunks.", "No cloud delivery or new Guard pass is claimed. Harmful, red-team and poisoning items remain local-only independently of model or Guard decisions.")
    save(fig, target / "privacy-boundary.png")


def export_charts(report_path, output=None):
    source = Path(report_path).resolve()
    payload = source.read_bytes()
    report = validate_report(json.loads(payload))
    target = Path(output).resolve() if output else source.parent / "charts"
    target.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 13, "axes.titleweight": "bold", "savefig.dpi": DPI})
    for exporter in [export_local, export_costs, export_workload, export_privacy]:
        exporter(report, target)
    files = [{"file": image.name, "sha256": hashlib.sha256(image.read_bytes()).hexdigest(), "width": 1920, "height": 1080} for image in sorted(target.glob("*.png"))]
    requirements = (ROOT / "scripts/stage4-plot-requirements.txt").read_bytes()
    libraries = {line.split("==")[0]: importlib.metadata.version(line.split("==")[0]) for line in requirements.decode("utf-8").splitlines() if "==" in line and not line.startswith("#")}
    normalized_sha = lambda data: hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()
    manifest = {"schemaVersion": 1, "runId": report["runId"], "population": report["primaryPopulation"], "exportedAt": datetime.now(timezone.utc).isoformat(), "sourceReportSha256": normalized_sha(payload), "sourceReport": source.name, "scriptSha256": normalized_sha(Path(__file__).read_bytes()), "requirementsSha256": normalized_sha(requirements), "sourceHashMethod": "SHA-256 of UTF-8 bytes normalized to LF", "pythonVersion": sys.version.split()[0], "libraries": libraries, "renderer": "matplotlib Agg", "cloudCalls": 0, "spendUsd": 0, "files": files, "limits": ["Wilson intervals are IID sensitivity; future accuracy is uncertified.", "Company arithmetic overlaps company single/multi-document categories.", "Cloud fees use offline input counts and assumed output lengths/prices.", "Proposed handoffs are not cloud deliveries; Guard outcomes remain pending.", "Business-data privacy counts include company documents and synthetic ad exports; the workload-mix company share means company-document queries."]}
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"runId": report["runId"], "charts": [file["file"] for file in files], "pixels": "1920x1080", "cloudCalls": 0, "spendUsd": 0}))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "results/2026-10-28-stage4-slice-report/report.json")
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    export_charts(arguments.report, arguments.output)

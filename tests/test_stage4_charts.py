"""Local chart-contract tests; no model, key, network or benchmark data used."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("stage4_chart_export", ROOT / "scripts/export-stage4-charts.py")
charts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(charts)
from PIL import Image


def fixture():
    models = [{"id": "llama3.1:8b", "label": "Llama 8B"}, {"id": "gemma3:4b", "label": "Gemma 4B"}, {"id": "gemma3:12b", "label": "Gemma 12B"}]
    rows, costs, privacy, mix = [], [], [], []
    for model in models:
        recommended = model["id"] == "gemma3:12b"
        for slice_id in charts.COST_SLICES:
            accepted = 1 if recommended and slice_id.startswith("company-") else 0
            rows.append({"population": "frozen-saved60", "modelId": model["id"], "sliceId": slice_id, "items": 2, "safeItems": 2, "accepted": accepted, "acceptedCorrect": accepted, "acceptanceRate": accepted/2, "acceptedAccuracy": 1 if accepted else None, "acceptedAccuracyWilson95": [.2, 1] if accepted else None, "escalationRate": 1-accepted/2, "medianLatencyMs": 500 if not recommended else 1000})
            for cloud, _ in charts.PROVIDERS:
                costs.append({"population": "frozen-saved60", "modelId": model["id"], "sliceId": slice_id, "cloudId": cloud, "costPer1000": .5 if accepted else 1, "cloudOnlyPer1000": 1, "savingPer1000": .5 if accepted else 0, "savingRate": .5 if accepted else 0})
        privacy.append({"population": "frozen-saved60", "modelId": model["id"], "companyQueries": 16, "fullyLocalCompanyQueries": 13 if recommended else 0, "proposedCompanyHandoffs": 3 if recommended else 16, "actualCloudCalls": 0, "actualCompanyCloudCalls": 0, "guardScreenedHandoffs": None, "draftPayloads": 0,"businessDataQueries":24,"documentCompanyQueries":16,"adPrivacyQueries":8,"fullyLocalBusinessDataQueries":13 if recommended else 0,"proposedBusinessHandoffs":11 if recommended else 24,"actualBusinessCloudCalls":0})
        for cloud, _ in charts.PROVIDERS:
            for share in [.25, .5, .75]:
                mix.append({"population": "frozen-saved60", "modelId": model["id"], "cloudId": cloud, "companyShare": share, "costPer1000": 1-share*.5, "cloudOnlyPer1000": 1, "savingPer1000": share*.5, "savingRate": share*.5})
    return {"runId": "stage4-chart-contract", "primaryPopulation": "frozen-saved60", "models": models, "cloudCalls": 0, "spendUsd": 0, "rows": rows, "costs": costs, "privacy": privacy, "workloadMix": mix, "recommendation": {"modelId": "gemma3:12b"}}


class Stage4ChartsTest(unittest.TestCase):
    def test_unmeasured_accuracy_and_paid_results_cannot_be_presented_as_measured(self):
        data = fixture()
        data["rows"][0]["acceptedAccuracy"] = 1
        with self.assertRaisesRegex(ValueError, "Zero acceptance"):
            charts.validate_report(data)
        data = fixture()
        data["cloudCalls"] = 1
        with self.assertRaisesRegex(ValueError, "zero-cloud"):
            charts.validate_report(data)
        data = fixture()
        data["privacy"][0]["actualCompanyCloudCalls"] = 1
        with self.assertRaisesRegex(ValueError, "offline study"):
            charts.validate_report(data)

    def test_overlapping_or_training_cohorts_cannot_silently_replace_saved_replay(self):
        data = fixture()
        data["primaryPopulation"] = "dev-fit"
        with self.assertRaisesRegex(ValueError, "independent saved60"):
            charts.validate_report(data)
        data = fixture()
        data["rows"][0]["acceptedAccuracyWilson95"] = [.9, .1]
        with self.assertRaisesRegex(ValueError, "Wilson"):
            charts.validate_report(data)

    def test_exports_four_real_pngs_with_exact_dimensions_and_provenance(self):
        temporary_parent = ROOT / ".logs" / "stage4-chart-tests"
        temporary_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="export-", dir=temporary_parent) as directory:
            source = Path(directory) / "report.json"
            source.write_text(json.dumps(fixture()), encoding="utf-8")
            manifest = charts.export_charts(source)
            self.assertEqual(len(manifest["files"]), 4)
            self.assertEqual(manifest["cloudCalls"], 0)
            self.assertEqual(manifest["sourceReportSha256"], charts.hashlib.sha256(source.read_bytes()).hexdigest())
            for item in manifest["files"]:
                with Image.open(source.parent / "charts" / item["file"]) as image:
                    self.assertEqual(image.size, (1920, 1080))
                    self.assertEqual(image.format, "PNG")
                self.assertEqual(len(item["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()

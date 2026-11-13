"""Offline behavior tests. All Meta transports are fakes; no external write is made."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import meta_common as common


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


publisher = module("publisher", "scripts/social/publish_reel.py")
report = module("report", "scripts/ads/ads_report.py")
creator = module("creator", "scripts/ads/ads_create.py")
renderer = module("renderer", "scripts/social/make_reel.py")
status = module("status_snapshot", "scripts/ops/status_snapshot.py")


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.token = self.root / "token"
        self.token.write_text("DO-NOT-PRINT-THIS-SECRET")
        self.token.chmod(0o600)
        self.video = self.root / "video.mp4"
        self.video.write_bytes(b"fixture")
        self.caption = self.root / "caption.txt"
        self.caption.write_text("Ein freigegebener Fall.\n", encoding="utf-8")
        self.thumb = self.root / "thumb.png"
        self.thumb.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        self.state = self.root / "state"
        self.public = self.root / "public"
        self.public.mkdir()

    def args(self):
        return argparse.Namespace(state_dir=str(self.state), mp4=str(self.video),
                                  public_root=str(self.public), public_base="https://safetyradar.ch",
                                  approval_ref="offline-test", timeout=60, poll_seconds=15,
                                  caption_file=str(self.caption), cover_file=None, marker_key="reel1_accident",
                                  published_dir=str(self.root / "published"), ops_journal=str(self.root / "ops.jsonl"),
                                  allow_marker_guard=False)

    def test_organic_account_is_distinct_from_existing_ad_identity(self):
        self.assertEqual(publisher.IG_USER_ID, "17841441257076577")
        self.assertEqual(creator.IG_USER_ID, "17841429970165089")

    def test_read_only_transport_blocks_posts_before_network(self):
        client = common.MetaClient(self.token)
        with patch.object(client._opener, "open") as network:
            with self.assertRaises(common.OperationError):
                client.post("123/media", {})
            network.assert_not_called()

    def test_error_does_not_echo_token_or_api_message(self):
        client = common.MetaClient(self.token)
        payload = json.dumps({"error": {"message": self.token.read_text(), "code": 190}}).encode()
        error = urllib.error.HTTPError("https://example.invalid/?access_token=" + self.token.read_text(), 400,
                                       "secret " + self.token.read_text(), {}, io.BytesIO(payload))
        with patch.object(client._opener, "open", side_effect=error):
            with self.assertRaises(common.OperationError) as caught:
                client.get("me")
        self.assertNotIn(self.token.read_text(), str(caught.exception))
        self.assertIn("code=190", str(caught.exception))
        self.assertTrue(error.closed)

    def test_token_permissions_rejected(self):
        self.token.chmod(0o644)
        with self.assertRaises(common.OperationError):
            common.MetaClient(self.token)

    def test_auth_redirects_are_not_followed(self):
        self.assertIsNone(common.NoRedirects().redirect_request(None, None, 302, "", {}, "https://attacker.invalid"))

    def test_pagination_uses_cursor_not_secret_url(self):
        client = common.MetaClient(self.token)
        responses = [{"data": [{"id": "1"}], "paging": {"next": "https://evil.invalid/?access_token=secret", "cursors": {"after": "cursor"}}}, {"data": [{"id": "2"}]}]
        with patch.object(client, "get", side_effect=responses) as get:
            self.assertEqual([r["id"] for r in client.pages("123/media")], ["1", "2"])
            self.assertEqual(get.call_args_list[1].args[0], "123/media")
            self.assertEqual(get.call_args_list[1].args[1]["after"], "cursor")

    def test_incomplete_pagination_fails_closed(self):
        client = common.MetaClient(self.token)
        with patch.object(client, "get", return_value={"data": [], "paging": {"next": "more"}}):
            with self.assertRaises(common.OperationError):
                list(client.pages("123/media"))

    def test_duplicate_caption_normalizes_unicode_whitespace_case(self):
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([{"id": "1", "caption": " EIN\u00a0Fall. ", "permalink": "https://instagram.com/reel/test"}])
        self.assertEqual(publisher.recent_duplicate(Fake(), "ein fall.")["media_id"], "1")

    def test_duplicate_publish_makes_no_post_or_public_copy(self):
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([{"id": "1", "caption": "Ein Fall.", "permalink": "https://instagram.com/reel/test"}])
            def post(self, *args, **kwargs):
                raise AssertionError("Must not POST")
        result = publisher.publish(Fake(), self.args(), "Ein Fall.", "x")
        self.assertTrue(result["duplicate"])
        self.assertEqual(list(self.public.iterdir()), [])

    def test_uncertain_publish_never_repeats_a_post(self):
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([])
            def post(self, *args, **kwargs):
                raise AssertionError("Must not POST")
        Fake.get = lambda *args, **kwargs: {"status_code": "FINISHED"}
        common.save_json(self.state / "reel-x.json", {"phase": "publish_pending", "container_id": "1"})
        with self.assertRaisesRegex(common.OperationError, "uncertain"):
            publisher.publish(Fake(), self.args(), "Ein Fall.", "x")

    def test_container_error_cleans_its_own_file_not_another(self):
        directory = self.public / "media-tmp"
        directory.mkdir()
        name = "sr-" + "a" * 32 + ".mp4"
        own = directory / name
        own.write_bytes(b"own")
        other = directory / "other.mp4"
        other.write_bytes(b"other")
        common.save_json(self.state / "reel-x.json", {"phase": "processing", "container_id": "1",
                                                       "public_root": str(self.public), "temp_name": name})
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([])
            def get(self, *args, **kwargs):
                return {"status_code": "ERROR"}
            def post(self, *args, **kwargs):
                raise AssertionError("Must not POST")
        with self.assertRaisesRegex(common.OperationError, "ERROR"):
            publisher.publish(Fake(), self.args(), "Ein Fall.", "x")
        self.assertFalse(own.exists())
        self.assertTrue(other.exists())

    def test_ready_container_publishes_once_and_returns_permalink(self):
        common.save_json(self.state / "reel-x.json", {"phase": "processing", "container_id": "container"})
        calls = []
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([])
            def get(self, path, *args, **kwargs):
                if path == "container":
                    return {"status_code": "FINISHED"}
                return {"id": "media", "permalink": "https://instagram.com/reel/example"}
            def post(self, path, params, **kwargs):
                calls.append((path, params))
                return {"id": "media"}
        result = publisher.publish(Fake(), self.args(), "Ein Fall.", "x")
        self.assertEqual(result["permalink"], "https://instagram.com/reel/example")
        self.assertEqual(calls, [(common.IG_USER_ID + "/media_publish", {"creation_id": "container"})])
        publisher.publish(Fake(), self.args(), "Ein Fall.", "x")
        self.assertEqual(len(calls), 1)

    def test_lost_publish_response_stays_pending_without_repeat(self):
        common.save_json(self.state / "reel-x.json", {"phase": "processing", "container_id": "container"})
        calls = []
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([])
            def get(self, *args, **kwargs):
                return {"status_code": "FINISHED"}
            def post(self, *args, **kwargs):
                calls.append(1)
                raise common.OperationError("Lost response")
        for _ in range(2):
            with self.assertRaises(common.OperationError):
                publisher.publish(Fake(), self.args(), "Ein Fall.", "x")
        self.assertEqual(calls, [1])
        self.assertEqual(common.load_json(self.state / "reel-x.json")["phase"], "publish_pending")

    def test_publish_dry_run_has_no_state_public_file_or_meta_call(self):
        class Fake:
            def __init__(self, *args, **kwargs):
                assert kwargs["read_only"]
            def __getattr__(self, key):
                raise AssertionError("Offline dry-run must not call Meta")
        with patch.object(publisher, "MetaClient", Fake), patch.object(publisher, "probe_video", return_value={}), contextlib.redirect_stdout(io.StringIO()) as out:
            publisher.main([str(self.video), str(self.caption), "--dry-run", "--state-dir", str(self.state), "--public-root", str(self.public)])
        self.assertTrue(json.loads(out.getvalue())["dry_run"])
        self.assertFalse(self.state.exists())
        self.assertEqual(list(self.public.iterdir()), [])

    def test_publish_requires_specific_approval_record(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            publisher.main([str(self.video), str(self.caption), "--execute"])
        self.assertEqual(caught.exception.code, 2)

    def test_marker_fallback_only_accepts_explicit_code_10(self):
        class Fake:
            code = 10
            def pages(self, *args, **kwargs):
                raise common.MetaAPIError("safe numeric error", code=self.code, status=400)
        args = self.args()
        with self.assertRaises(common.MetaAPIError):
            publisher.duplicate_check(Fake(), args, "caption", "x")
        args.allow_marker_guard = True
        self.assertIsNone(publisher.duplicate_check(Fake(), args, "caption", "x"))
        Fake.code = 190
        with self.assertRaises(common.MetaAPIError):
            publisher.duplicate_check(Fake(), args, "caption", "x")

    def test_published_marker_stops_before_any_network(self):
        args = self.args()
        common.save_json(publisher.marker_path(args), {"media_id": "existing", "permalink": "https://instagram.com/reel/existing"})
        class Fake:
            def __getattr__(self, key):
                raise AssertionError("Published marker must stop all API calls")
        result = publisher.publish(Fake(), args, "caption", "different-video")
        self.assertTrue(result["duplicate"])
        self.assertEqual(result["media_id"], "existing")

    def test_ops_journal_publication_stops_different_render_identity(self):
        args = self.args()
        Path(args.ops_journal).write_text(json.dumps({"approval_ref": args.approval_ref, "media_id": "existing"}) + "\n")
        self.assertEqual(publisher.check_markers(object(), args, "new-hash")["media_id"], "existing")

    def test_other_uncertain_job_is_read_before_no_new_write(self):
        args = self.args()
        common.save_json(self.state / "reel-old.json", {"approval_ref": args.approval_ref, "container_id": "old", "phase": "publish_pending"})
        class Fake:
            def get(self, path, params):
                self.asserted = path
                return {"status_code": "PUBLISHED"}
        fake = Fake()
        with self.assertRaisesRegex(common.OperationError, "PUBLISHED"):
            publisher.publish(fake, args, "caption", "new")
        self.assertEqual(fake.asserted, "old")

    def test_publisher_passes_exact_caption_and_explicit_feed_and_cover(self):
        args = self.args()
        args.cover_file = str(self.root / "cover.jpg")
        Path(args.cover_file).write_bytes(b"jpeg-fixture")
        calls = []
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([])
            def get(self, path, params):
                return {"status_code": "FINISHED"} if path == "container" else {"id": "media", "permalink": "https://instagram.com/reel/test"}
            def post(self, path, params):
                calls.append((path, params))
                return {"id": "container" if path.endswith("/media") else "media"}
        def serve(url, **kwargs):
            return io.BytesIO((self.public / "media-tmp" / url.rsplit("/", 1)[1]).read_bytes())
        caption = self.caption.read_text()
        with patch.object(publisher.urllib.request, "urlopen", side_effect=serve):
            result = publisher.publish(Fake(), args, caption, "x")
        self.assertEqual(calls[0][1]["caption"], caption)
        self.assertEqual(calls[0][1]["share_to_feed"], "true")
        self.assertTrue(calls[0][1]["cover_url"].endswith(".jpg"))
        self.assertEqual(result["media_id"], "media")
        self.assertEqual(list((self.public / "media-tmp").iterdir()), [])
        self.assertEqual(common.load_json(publisher.marker_path(args))["cover_source_sha256"], common.digest_file(args.cover_file))
        self.assertIn("reel_published", Path(args.ops_journal).read_text())

    def test_permalink_read_failure_keeps_success_marker_and_cannot_republish(self):
        args = self.args()
        common.save_json(self.state / "reel-x.json", {"phase": "processing", "container_id": "container"})
        calls = []
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([])
            def get(self, path, params):
                if path == "container":
                    return {"status_code": "FINISHED"}
                raise common.MetaAPIError("read unavailable", code=10, status=400)
            def post(self, path, params):
                calls.append(path)
                return {"id": "media"}
        with self.assertRaises(common.MetaAPIError):
            publisher.publish(Fake(), args, "caption", "x")
        self.assertEqual(common.load_json(publisher.marker_path(args))["media_id"], "media")
        self.assertTrue(publisher.publish(Fake(), args, "caption", "x")["duplicate"])
        self.assertEqual(len(calls), 1)

    def test_missing_color_tags_require_explicit_hash_and_wrong_hash_refused(self):
        info = {"streams": [{"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "width": 1080,
                            "height": 1920, "color_space": "bt709", "color_range": "tv"}], "format": {"duration": "25"}}
        with patch.object(common.subprocess, "run", return_value=argparse.Namespace(stdout=json.dumps(info))):
            with self.assertRaises(common.OperationError):
                common.probe_video(self.video, reel=True)
            self.assertIsNone(common.probe_video(self.video, reel=True, allow_missing_color_tags=True)["color_transfer"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            publisher.main([str(self.video), str(self.caption), "--dry-run", "--approved-video-sha256", "0" * 64])
        self.assertEqual(common.read_text(self.caption, strip=False), self.caption.read_text())

    def test_ad_payload_cannot_activate_or_set_budget(self):
        payload = creator.ad_payload("name", "creative")
        self.assertEqual(payload["status"], "PAUSED")
        self.assertEqual(payload["adset_id"], common.ADSET_ID)
        self.assertNotIn("daily_budget", payload)
        self.assertNotIn("lifetime_budget", payload)

    def test_ad_dry_run_is_paused_and_makes_no_state_or_meta_call(self):
        class Fake:
            def __init__(self, *args, **kwargs):
                assert kwargs["read_only"]
            def __getattr__(self, key):
                raise AssertionError("Offline dry-run must not call Meta")
        with patch.object(creator, "MetaClient", Fake), patch.object(creator, "probe_video", return_value={}), contextlib.redirect_stdout(io.StringIO()) as out:
            creator.main([str(self.video), "--thumbnail", str(self.thumb), "--message-file", str(self.caption),
                          "--name", "Test", "--variant", "a", "--dry-run", "--state-dir", str(self.state)])
        result = json.loads(out.getvalue())
        self.assertEqual(result["ad"]["status"], "PAUSED")
        self.assertEqual(result["object_story_spec"]["instagram_user_id"], "17841429970165089")
        self.assertEqual(result["object_story_spec"]["video_data"]["call_to_action"]["value"]["link"],
                         "https://safetyradar.ch/de/")
        self.assertFalse(result["activation_supported"])
        self.assertIn("utm_content=a", result["url_tags"])
        self.assertFalse(self.state.exists())

    def test_ad_activation_flag_not_supported(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            creator.main([str(self.video), "--thumbnail", str(self.thumb), "--message-file", str(self.caption),
                          "--name", "Test", "--variant", "a", "--dry-run", "--activate"])
        self.assertEqual(caught.exception.code, 2)

    def test_adset_and_currency_checked(self):
        class Fake:
            def get(self, *args, **kwargs):
                return {"currency": "USD"}
        with self.assertRaises(common.OperationError):
            creator.check_account(Fake())

    def test_uncertain_ad_creation_does_not_repeat(self):
        class Fake:
            def get(self, path, *args, **kwargs):
                if path.startswith("act_"):
                    return {"currency": "CHF"}
                return {"id": common.ADSET_ID, "account_id": common.ACCOUNT_ID, "campaign_id": common.CAMPAIGN_ID}
            def pages(self, *args, **kwargs):
                return iter([])
            def post(self, *args, **kwargs):
                raise AssertionError("Must not POST")
        common.save_json(self.state / "ad-x.json", {"phase": "ad_create_pending"})
        with self.assertRaisesRegex(common.OperationError, "uncertain"):
            creator.create_paused(Fake(), self.args(), "x", "name", {}, "tags")

    def test_paused_ad_flow_and_rerun_make_one_ad_only(self):
        calls = []
        class Fake:
            def get(self, path, *args, **kwargs):
                if path.startswith("act_"):
                    return {"currency": "CHF"}
                if path == common.ADSET_ID:
                    return {"id": common.ADSET_ID, "account_id": common.ACCOUNT_ID, "campaign_id": common.CAMPAIGN_ID}
                if path == "video":
                    return {"status": {"video_status": "ready"}}
                return {"id": "ad", "name": "name", "status": "PAUSED", "adset_id": common.ADSET_ID, "creative": {"id": "creative"}}
            def pages(self, *args, **kwargs):
                return iter([])
            def post(self, path, params=None, **kwargs):
                calls.append((path, params))
                if path.endswith("advideos"):
                    return {"id": "video"}
                if path.endswith("adimages"):
                    return {"images": {"image": {"hash": "hash"}}}
                if path.endswith("adcreatives"):
                    return {"id": "creative"}
                return {"id": "ad"}
        args = self.args()
        args.thumbnail = str(self.thumb)
        result = creator.create_paused(Fake(), args, "x", "name", {}, "tags")
        self.assertEqual(result["status"], "PAUSED")
        self.assertEqual(calls[-1][1]["status"], "PAUSED")
        self.assertEqual(len(calls), 4)
        creator.create_paused(Fake(), args, "x", "name", {}, "tags")
        self.assertEqual(len(calls), 4)

    def test_duplicate_names_fail_without_creating_another_object(self):
        class Fake:
            def pages(self, *args, **kwargs):
                return iter([{"id": "1", "name": "same"}, {"id": "2", "name": "same"}])
        with self.assertRaises(common.OperationError):
            creator.find_named(Fake(), "ads", "same")

    def test_readback_refuses_active_ad_without_changing_it(self):
        class Fake:
            def get(self, *args, **kwargs):
                return {"id": "1", "status": "ACTIVE", "adset_id": common.ADSET_ID}
        with self.assertRaises(common.OperationError):
            creator.verify_paused_ad(Fake(), "1")

    def test_link_metrics_ignore_other_actions_and_handle_zero(self):
        row = report.summarise({"ad_id": "1", "spend": "1.00", "impressions": "100", "reach": "80",
                                "actions": [{"action_type": "link_click", "value": "2"}, {"action_type": "post_engagement", "value": "50"}]})
        self.assertEqual(row["link_cpc"], 0.5)
        self.assertEqual(row["link_ctr_pct"], 2.0)
        empty = report.summarise({"ad_id": "1"})
        self.assertIsNone(empty["link_cpc"])
        self.assertIsNone(empty["link_ctr_pct"])

    def test_report_dry_run_uses_read_only_client_without_network(self):
        class Fake:
            def __init__(self, *args, **kwargs):
                assert kwargs["read_only"]
            def __getattr__(self, key):
                raise AssertionError("Offline dry-run must not call Meta")
        with patch.object(report, "MetaClient", Fake), contextlib.redirect_stdout(io.StringIO()) as out:
            report.main(["--since", "2026-11-09", "--until", "2026-11-09", "--dry-run"])
        self.assertEqual(json.loads(out.getvalue())["query"]["level"], "ad")

    def test_report_does_not_sum_reach_and_checks_currency(self):
        class Fake:
            def __init__(self, *args, **kwargs):
                assert kwargs["read_only"]
            def get(self, *args, **kwargs):
                return {"currency": "CHF", "timezone_name": "Europe/Zurich"}
            def pages(self, *args, **kwargs):
                return iter([{"ad_id": "1", "spend": "1.23", "reach": "10"}, {"ad_id": "2", "spend": "0.11", "reach": "10"}])
        with patch.object(report, "MetaClient", Fake), contextlib.redirect_stdout(io.StringIO()) as out:
            report.main(["--since", "2026-11-09", "--until", "2026-11-09"])
        result = json.loads(out.getvalue())
        self.assertEqual(result["totals"]["spend"], 1.34)
        self.assertNotIn("reach", result["totals"])

    def test_journal_atomic_private_and_readable(self):
        p = self.state / "operation.json"
        common.save_json(p, {"phase": "pending"})
        common.save_json(p, {"phase": "complete"})
        self.assertEqual(common.load_json(p), {"phase": "complete"})
        self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_lock_blocks_concurrent_operation(self):
        with common.operation_lock(self.state, "same"):
            with self.assertRaises(common.OperationError):
                with common.operation_lock(self.state, "same"):
                    self.fail("second lock acquired")

    def test_reading_pace_and_dense_sanction_hold(self):
        self.assertEqual(renderer.WPM, 190)
        self.assertGreater(renderer.reading_hold(renderer.SANCTION, sanction=True),
                           renderer.reading_hold(renderer.SANCTION))
        self.assertGreaterEqual(renderer.reading_hold(""), 1.5)



class StatusSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stats = self.root / "stats"
        self.stats.mkdir()
        self.archive = self.stats / "status-archive"
        self.journal = self.root / "ops" / "journal.jsonl"
        self.token = self.root / "token"
        self.token.write_text("DO-NOT-PRINT-THIS-SECRET")
        self.token.chmod(0o600)

    def write_analytics(self):
        payload = {
            "from": "2026-09-16", "through": "2026-11-10",
            "metrics": {"pageviews": 10, "signupSubmissions": 1, "signupAcceptedResponses": 0,
                        "signupConfirmedResponses": 0, "engagementSamples": 8, "activeSeconds": 40},
            "byCampaign": [{"source": "fb", "medium": "paid_social", "campaign": "de-2026-w46",
                            "variant": "a", "pageviews": 7, "signupSubmissions": 1,
                            "signupAcceptedResponses": 0, "signupConfirmedResponses": 0}],
        }
        (self.stats / "analytics-latest.json").write_text(json.dumps(payload), encoding="utf-8")
        (self.stats / "analytics-latest.txt").write_text(
            "Safety Radar aggregate measurement: 2026-09-16–2026-11-10 (Europe/Zurich)\n"
            "pageviews: 10\n\n"
            "Campaign cohorts (views / submissions / accepted / confirmed):\n"
            "fb de-2026-w46 a: 7 / 1 / 0 / 0\n",
            encoding="utf-8",
        )

    def test_health_classification(self):
        blocked = common.MetaAPIError("safe", code=200, status=403,
                                      api_message="API access blocked", fbtrace_id="Trace123")
        token = common.MetaAPIError("safe", code=190, status=400, api_message="Invalid OAuth access token")
        permission = common.MetaAPIError("safe", code=10, status=400, api_message="Application does not have permission")
        permission200 = common.MetaAPIError("safe", code=200, status=403,
                                            api_message="Requires permission ads_read")
        other = common.MetaAPIError("safe", code=1, status=500, api_message="unknown")
        self.assertEqual(common.classify_meta_health(blocked), "BLOCKED")
        self.assertEqual(common.classify_meta_health(token), "TOKEN")
        self.assertEqual(common.classify_meta_health(permission), "PERMISSION")
        self.assertEqual(common.classify_meta_health(permission200), "PERMISSION")
        self.assertIsNone(common.classify_meta_health(other))
        self.assertIsNone(common.classify_meta_health(common.OperationError("no")))

    def test_sanitize_keeps_blocked_text_and_redacts_token(self):
        secret = "DO-NOT-PRINT-THIS-SECRET"
        self.assertEqual(common.sanitize_meta_text("API access blocked"), "API access blocked")
        self.assertNotIn(secret, common.sanitize_meta_text("token=" + secret, token=secret) or "")
        self.assertIn("[redacted]", common.sanitize_meta_text("token=" + secret, token=secret))
        self.assertNotIn(secret, common.sanitize_meta_text("EAA1234567890abcdefTOKENVALUEISH"))
        self.assertEqual(common.fbtrace_id("AbCdEf123"), "AbCdEf123")
        self.assertIsNone(common.fbtrace_id("has a space"))

    def test_client_captures_sanitized_message_and_trace(self):
        client = common.MetaClient(self.token)
        payload = json.dumps({"error": {"message": self.token.read_text(), "code": 190,
                                        "fbtrace_id": "TraceXYZ", "type": "OAuthException"}}).encode()
        error = urllib.error.HTTPError("https://example.invalid/?access_token=" + self.token.read_text(), 400,
                                       "secret " + self.token.read_text(), {}, io.BytesIO(payload))
        with patch.object(client._opener, "open", side_effect=error):
            with self.assertRaises(common.MetaAPIError) as caught:
                client.get("me")
        exc = caught.exception
        self.assertNotIn(self.token.read_text(), str(exc))
        self.assertNotIn(self.token.read_text(), exc.api_message or "")
        self.assertEqual(exc.api_message, "[redacted]")
        self.assertEqual(exc.fbtrace_id, "TraceXYZ")
        self.assertEqual(exc.code, 190)
        self.assertEqual(common.classify_meta_health(exc), "TOKEN")

    def test_capi_counts_last_error_and_journal_mirror(self):
        import datetime as dt
        capi = Path(self.stats) / "capi"
        capi.mkdir(parents=True, exist_ok=True)
        (capi / "2026-11-13.json").write_text(json.dumps({
            "day": "2026-11-13", "sent": {"EngagedVisit": 3, "Lead": 1}, "failed": {"EngagedVisit": 1}, "test": {"Lead": 1},
            "errors": [{"at": "2026-11-13T09:00:00.000Z", "event": "EngagedVisit", "test": False, "status": 400,
                        "code": 100, "message": "Invalid parameter", "fbtrace_id": "TraceCapi"}]}))
        (capi / "2026-11-10.json").write_text(json.dumps({"day": "2026-11-10", "sent": {"EngagedVisit": 2}, "failed": {}, "test": {}, "errors": []}))
        (capi / "2026-10-01.json").write_text(json.dumps({"day": "2026-10-01", "sent": {"EngagedVisit": 99}, "failed": {}, "test": {}, "errors": []}))
        result = status.load_capi(capi, dt.date(2026, 11, 13))
        self.assertEqual(result["today"]["sent"], {"EngagedVisit": 3, "Lead": 1})
        self.assertEqual(result["last_7_days"]["sent"], {"EngagedVisit": 5, "Lead": 1})
        self.assertEqual(result["today"]["failed"]["EngagedVisit"], 1)
        self.assertEqual(result["test_today"]["Lead"], 1)
        self.assertEqual(result["last_error"]["fbtrace_id"], "TraceCapi")
        text = "\n".join(status.format_capi_lines(result))
        self.assertIn("today: EngagedVisit sent 3 failed 1  Lead sent 1 failed 0", text)
        self.assertIn("TraceCapi", text)
        journal = Path(self.temp.name) / "journal.jsonl"
        marker = capi / ".journaled-through"
        self.assertEqual(status.journal_capi_errors(result, journal, marker), 1)
        self.assertEqual(status.journal_capi_errors(result, journal, marker), 0)
        record = json.loads(journal.read_text().splitlines()[0])
        self.assertEqual(record["event"], "capi_error")
        self.assertEqual(record["code"], 100)

    def test_health_line_is_first_status_fields_and_journal_on_block(self):
        self.write_analytics()
        calls = []

        class Fake:
            def get(self, path, params=None):
                calls.append(path)
                raise common.MetaAPIError("safe", code=200, status=403,
                                          api_message="API access blocked", fbtrace_id="TraceBlock")

            def pages(self, *args, **kwargs):
                raise AssertionError("Must not page after a blocked get")

        now = __import__("datetime").datetime(2026, 11, 10, 21, 0, tzinfo=status.ZURICH)
        snapshot = status.build_snapshot(
            Fake(), now=now, stats_dir=self.stats,
            listmonk_fn=lambda: {"total": 2, "confirmed": 0, "created_last_7_days": 2},
            generated_on="vps",
        )
        self.assertEqual(snapshot["meta_api_health"], "BLOCKED")
        self.assertEqual(snapshot["meta_api_error"]["fbtrace_id"], "TraceBlock")
        self.assertEqual(snapshot["analytics"]["metrics"]["pageviews"], 10)
        self.assertEqual(snapshot["listmonk"]["total"], 2)
        self.assertEqual(snapshot["ads"], None)
        self.assertEqual(len(calls), 1)
        text = status.format_status_text(snapshot)
        first_fields = [line for line in text.splitlines() if line.startswith("meta_api_health") or line.startswith("generated_at") or line.startswith("Safety Radar") or line.startswith("meta_api_error") or line.startswith("fbtrace_id")]
        self.assertEqual(first_fields[0], "Safety Radar status snapshot")
        self.assertIn("meta_api_health: BLOCKED", text.splitlines()[:6])
        self.assertTrue(text.index("meta_api_health: BLOCKED") < text.index("== Ads"))
        self.assertIn("meta_api_error: API access blocked", text)
        self.assertIn("fbtrace_id: TraceBlock", text)
        self.assertIn("unavailable because Meta API is BLOCKED", text)
        self.assertIn("fb de-2026-w46 a: 7 / 1 / 0 / 0", text)
        self.assertIn("total: 2", text)
        paths = status.write_snapshot(snapshot, stats_dir=self.stats, archive_dir=self.archive,
                                      ops_journal=self.journal, now=now)
        self.assertTrue(Path(paths["txt"]).is_file())
        self.assertTrue((self.archive / "status-2026-11-10.txt").is_file())
        events = [json.loads(line) for line in self.journal.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(events[0]["health"], "BLOCKED")
        self.assertEqual(events[0]["fbtrace_id"], "TraceBlock")
        self.assertNotIn(self.token.read_text(), self.journal.read_text())

    def test_pipeline_flags_failed_and_stale_release_at_top(self):
        dt = __import__("datetime").datetime
        now = dt(2026, 11, 13, 4, 0, tzinfo=status.ZURICH)
        started = int(dt(2026, 11, 12, 7, 1, tzinfo=status.ZURICH).timestamp())
        with tempfile.TemporaryDirectory() as tmp:
            rel = Path(tmp) / "www.releases" / "20261109-070851-e6c3d33"
            rel.mkdir(parents=True)
            link = Path(tmp) / "www"
            link.symlink_to(rel)
            show = lambda unit: {"Result": "exit-code", "ExecMainStatus": "1", "ActiveState": "failed",
                                 "ExecMainStartTimestamp": f"@{started}", "ExecMainExitTimestamp": f"@{started + 300}"}
            failed = status.collect_pipeline(now, show=show, live_link=link)
            ok = status.collect_pipeline(now, show=lambda unit: {**show(unit), "Result": "success", "ExecMainStatus": "0"},
                                         live_link=link)
        self.assertEqual(failed["flags"], ["FAILED", "STALE"])
        self.assertEqual(failed["live_release_age_hours"], 92.9)
        self.assertEqual(ok["flags"], ["STALE"])  # > 80 h without a rebuild
        line = status.format_pipeline_line(failed)
        self.assertTrue(line.startswith("pipeline: FAILED/STALE – last daily update 2026-11-12 07:01 Europe/Zurich: exit-code (exit 1)"))
        text = status.format_status_text({"generated_at": now.isoformat(), "meta_api_health": "OK", "pipeline": failed,
                                          "ads": None, "instagram": None, "page": None, "analytics": None,
                                          "page_analytics": None, "capi": None, "listmonk": {"available": False, "error": "x"}})
        self.assertEqual(text.splitlines()[1], line)

    def test_ok_snapshot_does_not_journal_and_skips_ig_insights(self):
        self.write_analytics()
        calls = []

        class Fake:
            def get(self, path, params=None):
                calls.append(path)
                if path == f"act_{common.ACCOUNT_ID}":
                    return {"currency": "CHF", "timezone_name": "Europe/Zurich"}
                if path == common.CAMPAIGN_ID:
                    return {"id": common.CAMPAIGN_ID, "name": "Safety Radar — DE Newsletter",
                            "status": "ACTIVE", "effective_status": "ACTIVE", "objective": "OUTCOME_TRAFFIC"}
                if path == common.IG_USER_ID:
                    if "followers_count" not in (params or {}).get("fields", ""):
                        raise AssertionError("expected followers_count request")
                    return {"username": "safetyradarch", "followers_count": 12, "media_count": 1}
                if path.endswith("/media"):
                    return {"data": [{"id": "media1", "timestamp": "2026-11-10T06:23:40+0000",
                                      "permalink": "https://www.instagram.com/reel/example/",
                                      "media_type": "REELS", "like_count": 3}]}
                if path == "me/accounts":
                    return {"data": []}
                if path.startswith(f"act_{common.ACCOUNT_ID}/ads"):
                    return {"data": [{"creative": {"object_story_spec": {"page_id": common.PAGE_ID}}}]}
                if path == common.PAGE_ID:
                    return {"id": common.PAGE_ID, "name": "Safety Radar", "fan_count": 0, "followers_count": 0}
                if path == f"{common.PAGE_ID}/insights":
                    raise common.MetaAPIError("safe", code=10, status=400,
                                              api_message="Application does not have permission")
                if path == "media1/insights":
                    raise common.MetaAPIError("safe", code=10, status=400,
                                              api_message="Application does not have permission")
                raise AssertionError("unexpected get " + path)

            def pages(self, path, params=None, **kwargs):
                calls.append(path)
                if path.endswith("/ads"):
                    return iter([{"id": "52544780253676", "name": "A", "status": "ACTIVE",
                                  "effective_status": "ACTIVE", "creative": {"id": "1", "status": "ACTIVE"},
                                  "ad_review_feedback": {}, "issues_info": []}])
                if path.endswith("/insights") and params["level"] == "ad":
                    return iter([{"ad_id": "52544780253676", "ad_name": "A", "spend": "1.00",
                                  "impressions": "100", "reach": "80", "clicks": "4",
                                  "actions": [{"action_type": "link_click", "value": "2"},
                                              {"action_type": "post_engagement", "value": "50"}]}])
                if path.endswith("/insights") and params["level"] == "campaign":
                    return iter([{"campaign_id": common.CAMPAIGN_ID, "spend": "1.00", "impressions": "100",
                                  "reach": "80", "clicks": "4",
                                  "actions": [{"action_type": "link_click", "value": "2"}]}])
                return iter([])

        now = __import__("datetime").datetime(2026, 11, 10, 21, 0, tzinfo=status.ZURICH)
        snapshot = status.build_snapshot(
            Fake(), now=now, stats_dir=self.stats,
            listmonk_fn=lambda: {"total": 2, "confirmed": 0, "created_last_7_days": 2},
            generated_on="vps",
        )
        self.assertEqual(snapshot["meta_api_health"], "OK")
        self.assertIsNone(snapshot["meta_api_error"])
        self.assertEqual(snapshot["instagram"]["followers"], 12)
        self.assertTrue(any("insights skipped" in note for note in snapshot["instagram"]["notes"]))
        self.assertIsNone(snapshot["instagram"]["recent_media"][0]["plays"])
        ad = snapshot["ads"]["periods"]["today"]["ads"][0]
        self.assertEqual(ad["link_cpc"], 0.5)
        self.assertEqual(ad["link_ctr_pct"], 2.0)
        self.assertEqual(ad["clicks"], 4)
        self.assertEqual(ad["cpc"], 0.25)
        # A later insights permission must not flip the whole snapshot to PERMISSION,
        # and must not trigger more insight calls.
        self.assertEqual(calls.count("media1/insights"), 1)
        paths = status.write_snapshot(snapshot, stats_dir=self.stats, archive_dir=self.archive,
                                      ops_journal=self.journal, now=now)
        self.assertFalse(self.journal.exists())
        text = Path(paths["txt"]).read_text(encoding="utf-8")
        self.assertIn("meta_api_health: OK", text.splitlines()[:6])
        self.assertIn("link_clicks 2", text)
        self.assertIn("followers: 12", text)
        self.assertIn("https://www.instagram.com/reel/example/", text)
        self.assertIn("Lifetime through 2026-11-10", text)
        self.assertNotIn("Lifetime lifetime", text)
        self.assertIn("2026-11-10 07:23 Europe/Zurich", text)
        self.assertIn("== Facebook Page ==", text)
        self.assertIn("resolved_from: ad creative object_story_spec", text)
        self.assertTrue(any("Page insights" in note or "unavailable" in note for note in snapshot["page"]["notes"]) or "unavailable" in text)
        self.assertEqual(snapshot["meta_api_health"], "OK")

    def test_link_metrics_match_ads_report(self):
        row = {"ad_id": "1", "spend": "1.00", "impressions": "100", "reach": "80", "clicks": "10",
               "actions": [{"action_type": "link_click", "value": "2"}, {"action_type": "post_engagement", "value": "50"}]}
        snapshot_row = status.metric_block(row)
        report_row = report.summarise(row)
        self.assertEqual(snapshot_row["link_cpc"], report_row["link_cpc"])
        self.assertEqual(snapshot_row["link_ctr_pct"], report_row["link_ctr_pct"])
        self.assertEqual(snapshot_row["link_clicks"], report_row["link_clicks"])
        self.assertEqual(snapshot_row["spend"], report_row["spend"])
        self.assertEqual(snapshot_row["impressions"], report_row["impressions"])

    def test_dry_run_and_non_vps_guard(self):
        class Fake:
            def __init__(self, *args, **kwargs):
                raise AssertionError("Dry-run must not construct a Meta client")

        with patch.object(status, "MetaClient", Fake), contextlib.redirect_stdout(io.StringIO()) as out:
            status.main(["--dry-run", "--stats-dir", str(self.stats), "--archive-dir", str(self.archive),
                         "--ops-journal", str(self.journal)])
        result = json.loads(out.getvalue())
        self.assertTrue(result["dry_run"])
        self.assertTrue(result["read_only"])
        self.assertFalse(self.journal.exists())
        self.assertEqual(list(self.stats.iterdir()), [])
        with patch.object(status, "on_vps", return_value=False):
            with self.assertRaises(common.OperationError) as caught:
                status.main(["--stats-dir", str(self.stats), "--archive-dir", str(self.archive),
                             "--ops-journal", str(self.journal), "--token-file", str(self.token)])
        self.assertIn("VPS", str(caught.exception))


    def write_events(self):
        events = self.stats / "events"
        events.mkdir()
        def row(page, source, variant, views, samples, active, d50, d100, signups, campaign="de-2026-w46", medium="paid_social"):
            if source == "unattributed":
                medium, campaign, variant_name = "none", "none", "none"
            else:
                variant_name = variant
            return {"page": page, "language": "de", "category": "home", "article": None,
                    "source": source, "medium": medium, "campaign": campaign, "variant": variant_name,
                    "pageviews": views, "engagementSamples": samples, "activeSeconds": active,
                    "depth25": d50, "depth50": d50, "depth75": d100, "depth100": d100,
                    "signupSubmissions": signups, "signupAcceptedResponses": 0, "signupConfirmedResponses": 0}
        (events / "2026-11-10.json").write_text(json.dumps({"day": "2026-11-10", "rows": {
            "1": row("/de/", "fb", "a", 10, 8, 40, 6, 2, 1),
            "2": row("/de/", "fb", "b", 4, 4, 8, 2, 1, 0),
            "3": row("/de/", "unattributed", None, 5, 5, 10, 3, 1, 0),
            "4": row("/de/newsletter/", "fb", "a", 3, 3, 6, 1, 0, 0),
        }}), encoding="utf-8")
        (events / "2026-11-09.json").write_text(json.dumps({"day": "2026-11-09", "rows": {
            "1": row("/de/", "fb", "a", 2, 2, 10, 1, 1, 0),
        }}), encoding="utf-8")
        (events / "2026-11-10.test.json").write_text(json.dumps({"day": "2026-11-10", "rows": {
            "1": row("/de/", "fb", "a", 999, 1, 1, 1, 1, 9),
        }}), encoding="utf-8")

    def test_page_analytics_tables_and_retarget_split(self):
        self.write_events()
        report = status.build_page_analytics(self.stats / "events", __import__("datetime").date(2026, 11, 10))
        today = {row["page"]: row for row in report["windows"]["today"]["pages"]}
        self.assertEqual(today["/de/"]["pageviews"], 19)
        self.assertEqual(today["/de/"]["avg_active_seconds"], 3.4)  # 58/17
        self.assertEqual(today["/de/"]["signup_submissions"], 1)
        cohorts = {item["cohort"]: item for item in today["/de/"]["cohorts"]}
        self.assertEqual(cohorts["fb a"]["pageviews"], 10)
        self.assertNotIn(999, [today["/de/"]["pageviews"]])
        last_7 = {row["page"]: row for row in report["windows"]["last_7"]["pages"]}
        self.assertEqual(last_7["/de/"]["pageviews"], 21)
        all_time = {row["page"]: row for row in report["windows"]["all_time"]["pages"]}
        self.assertEqual(all_time["/de/"]["pageviews"], 21)
        home = report["homepage_since_retarget"]["page"]
        self.assertEqual(home["pageviews"], 19)  # only 2026-11-10 onward
        text = status.format_status_text({
            "generated_at": "2026-11-10T21:00:00+01:00", "generated_on": "vps",
            "meta_api_health": "OK", "ads": None, "instagram": None, "page": None,
            "analytics": {}, "page_analytics": report, "listmonk": {"available": False},
        })
        self.assertIn("Homepage /de/ since retarget", text)
        self.assertIn("fb a: views 10", text)
        self.assertNotIn("views 999", text)
        self.assertIn("cannot be split out", text)

    def test_page_insights_skips_deprecated_metric(self):
        calls = []

        class Fake:
            def get(self, path, params=None):
                calls.append((path, (params or {}).get("metric")))
                if path == "me/accounts":
                    return {"data": [{"id": common.PAGE_ID, "name": "Safety Radar", "fan_count": 3, "followers_count": 3}]}
                if path == common.PAGE_ID:
                    return {"id": common.PAGE_ID, "name": "Safety Radar", "fan_count": 3, "followers_count": 3}
                if path == f"{common.PAGE_ID}/insights":
                    metric = (params or {}).get("metric", "")
                    if "," in metric:
                        raise common.MetaAPIError("safe", code=100, status=400,
                                                  api_message="The metric page_follows is not available")
                    name = metric
                    return {"data": [{"name": name, "period": "day", "values": [
                        {"value": 4 if name == "page_views_total" else 7,
                         "end_time": "2026-11-11T08:00:00+0000"},
                    ]}]}
                raise AssertionError("unexpected " + path)

        page = status.collect_page(Fake(), __import__("datetime").date(2026, 11, 10))
        self.assertEqual(page["resolved_from"], "me/accounts")
        self.assertEqual(page["followers"], 3)
        self.assertEqual(page["metrics"]["page_views_total"]["today"], 4)
        self.assertEqual(page["metrics"]["page_views_total"]["last_7"], 4)
        self.assertEqual(page["metrics"]["page_post_engagements"]["today"], 7)
        self.assertNotIn("page_follows", page["metrics"])
        self.assertTrue(any("page_follows" in note for note in page["notes"]))
        self.assertGreaterEqual(len([c for c in calls if c[0].endswith("/insights")]), 2)
        text = status.format_status_text({
            "generated_at": "2026-11-10T21:00:00+01:00", "generated_on": "vps",
            "meta_api_health": "OK", "ads": None, "instagram": None, "page": page,
            "analytics": {}, "page_analytics": {"available": False},
            "listmonk": {"available": False},
        })
        self.assertIn("page views (page_views_total): 4", text)
        self.assertIn("post engagements (page_post_engagements): 7", text)
        self.assertIn("page_follows unavailable", text)

    def test_insight_day_and_zurich_format(self):
        self.assertEqual(status.insight_day("2026-11-11T08:00:00+0000"), "2026-11-10")
        self.assertEqual(status.format_zurich("2026-11-10T06:23:33+0000"), "2026-11-10 07:23 Europe/Zurich")


    def test_page_access_token_error_does_not_mark_snapshot_token(self):
        self.write_analytics()
        class Fake:
            def get(self, path, params=None):
                if path == f"act_{common.ACCOUNT_ID}":
                    return {"currency": "CHF", "timezone_name": "Europe/Zurich"}
                if path == common.CAMPAIGN_ID:
                    return {"id": common.CAMPAIGN_ID, "name": "Campaign", "status": "ACTIVE",
                            "effective_status": "ACTIVE"}
                if path == common.IG_USER_ID:
                    return {"username": "safetyradarch", "followers_count": 0, "media_count": 0}
                if path.endswith("/media"):
                    return {"data": []}
                if path == "me/accounts":
                    return {"data": []}
                if path.startswith(f"act_{common.ACCOUNT_ID}/ads"):
                    return {"data": [{"creative": {"object_story_spec": {"page_id": common.PAGE_ID}}}]}
                if path == common.PAGE_ID or path.startswith(common.PAGE_ID + "/"):
                    raise common.MetaAPIError("safe", code=190, status=400,
                                              api_message="(#190) This method must be called with a Page Access Token")
                raise AssertionError("unexpected " + path)

            def pages(self, path, params=None, **kwargs):
                if path.endswith("/ads"):
                    return iter([])
                if path.endswith("/insights"):
                    return iter([])
                return iter([])

        snapshot = status.build_snapshot(
            Fake(), now=__import__("datetime").datetime(2026, 11, 10, 21, 0, tzinfo=status.ZURICH),
            stats_dir=self.stats, listmonk_fn=lambda: {"total": 0, "confirmed": 0, "created_last_7_days": 0},
            generated_on="vps",
        )
        self.assertEqual(snapshot["meta_api_health"], "OK")
        self.assertIsNotNone(snapshot["ads"])
        self.assertTrue(any("Page access token" in note or "Page access token" in note.lower() or "page access token" in note.lower() for note in snapshot["page"]["notes"]))
        text = status.format_status_text(snapshot)
        self.assertIn("meta_api_health: OK", text)
        self.assertIn("== Facebook Page ==", text)
        self.assertNotIn("unavailable because Meta API is TOKEN", text)


if __name__ == "__main__":
    unittest.main()

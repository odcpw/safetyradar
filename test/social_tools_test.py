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


if __name__ == "__main__":
    unittest.main()

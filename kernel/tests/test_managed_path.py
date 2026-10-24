"""Commands the kernel starts can use tools FRIDAY installed under runtime/."""

import json
import os
import tempfile
import unittest

import env_guard


class ManagedPathTests(unittest.TestCase):
    def test_child_env_appends_managed_dirs_after_system_path(self):
        with tempfile.TemporaryDirectory() as root:
            tool = os.path.join(root, "runtime", "gh", "bin")
            os.makedirs(tool)
            with open(os.path.join(root, "runtime", "managed-path.json"), "w", encoding="utf-8") as f:
                json.dump({"dirs": [tool, os.path.join(root, "gone")]}, f)
            env = env_guard.child_env({"PATH": os.pathsep.join(["/usr/bin", "/bin"]), "FRIDAY_ROOT": root})
            parts = env["PATH"].split(os.pathsep)
            self.assertEqual(parts[:2], ["/usr/bin", "/bin"])
            self.assertIn(tool, parts)
            self.assertNotIn(os.path.join(root, "gone"), parts)
            self.assertEqual(env_guard.child_env({"PATH": env["PATH"], "FRIDAY_ROOT": root})["PATH"], env["PATH"])

    def test_missing_or_broken_list_changes_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(env_guard.managed_dirs(root), [])
            os.makedirs(os.path.join(root, "runtime"))
            with open(os.path.join(root, "runtime", "managed-path.json"), "w", encoding="utf-8") as f:
                f.write("{not json")
            self.assertEqual(env_guard.managed_dirs(root), [])
            self.assertEqual(env_guard.child_env({"PATH": "/usr/bin"})["PATH"], "/usr/bin")


if __name__ == "__main__":
    unittest.main()

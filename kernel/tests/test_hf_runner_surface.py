"""The Hugging Face runner is a local OpenAI-compatible engine on its own port."""

import unittest

import billing
import router


class HfRunnerSurface(unittest.TestCase):
    def test_router_speaks_openai_to_the_runner_port(self) -> None:
        surface = router.PROVIDER_SURFACES["transformers"]
        self.assertEqual(surface["wire"], "openai")
        self.assertEqual(surface["base"], "http://127.0.0.1:8083/v1")
        self.assertIn("transformers", router.OPENAI_COMPATIBLE)

    def test_runner_does_not_share_vllm_port(self) -> None:
        self.assertNotEqual(
            router.PROVIDER_SURFACES["transformers"]["base"],
            router.PROVIDER_SURFACES["vllm"]["base"],
        )

    def test_runner_is_local_and_free(self) -> None:
        model = {"id": "transformers/any", "type": "transformers"}
        self.assertEqual(billing.billing_class(model), "free")


if __name__ == "__main__":
    unittest.main()

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from power_monitor import cli


class CliTests(unittest.TestCase):
    @patch("power_monitor.cli.uvicorn.run")
    @patch("power_monitor.cli.subprocess.run")
    def test_build_precedes_server(self, build, server):
        order = []
        build.side_effect = lambda *a, **kw: order.append("build")
        server.side_effect = lambda *a, **kw: order.append("server")
        with patch("sys.argv", ["power-monitor", "--port", "38001"]):
            cli.main()
        self.assertEqual(order, ["build", "server"])
        build.assert_called_once_with(
            ["npm", "run", "build"],
            cwd=Path(cli.__file__).resolve().parent.parent / "web", check=True,
        )
        self.assertEqual(server.call_args.kwargs["port"], 38001)

    @patch("power_monitor.cli.uvicorn.run")
    @patch("power_monitor.cli.subprocess.run")
    def test_failed_build_prevents_startup(self, build, server):
        for error in (FileNotFoundError(), subprocess.CalledProcessError(2, "npm")):
            with self.subTest(error=error), patch("sys.argv", ["power-monitor"]):
                build.side_effect = error
                with self.assertRaises(SystemExit) as raised:
                    cli.main()
                self.assertNotEqual(raised.exception.code, 0)
                server.assert_not_called()

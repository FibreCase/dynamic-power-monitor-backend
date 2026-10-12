"""All-time extrema API checks without hardware or a listening server."""
import tempfile
import unittest
from pathlib import Path

import httpx

from power_monitor.app import App
from power_monitor.db import Database


class ExtremaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tmp.name) / "samples.db")
        await self.db.start()

    async def asyncTearDown(self):
        await self.db.stop()
        self.tmp.cleanup()

    async def test_empty_and_missing_temperature(self):
        empty = await self.db.query_extrema()
        self.assertTrue(all(v == {"min": None, "max": None} for v in empty.values()))
        await self.db._flush([(1, 1, 12, 0, 0, None)])
        result = await self.db.query_extrema()
        self.assertEqual(result["current"], {"min": None, "max": None})
        self.assertEqual(result["power"], {"min": None, "max": None})
        self.assertEqual(result["temperature"], {"min": None, "max": None})

    async def test_zero_is_ignored_independently_for_each_metric(self):
        await self.db._flush([
            (1, 1, 0, -20, 0, 0),
            (2, 2, 12, 0, -180, None),
            (3, 3, 15, -10, -120, 25),
        ])
        self.assertEqual(await self.db.query_extrema(), {
            "voltage": {"min": 12, "max": 15},
            "current": {"min": -20, "max": -10},
            "power": {"min": -180, "max": -120},
            "temperature": {"min": 25, "max": 25},
        })

    async def test_api_includes_old_samples_and_survives_restart(self):
        # Old extrema must remain visible beyond the history API's 5000-row cap.
        await self.db._flush([
            (1, 1, 9, -20, -180, None),
            (2, 2, 15, 2000, 30000, 50),
            *[(i, i, 12, 100, 1200, 25) for i in range(3, 5010)],
        ])
        await self.db.put_event(6000, 6000, "device", 1, 99, 99999, 999999)
        await self.db.stop()
        await self.db.start()
        app = App()
        app.db = self.db
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app.app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/extrema")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "voltage": {"min": 9, "max": 15},
            "current": {"min": -20, "max": 2000},
            "power": {"min": -180, "max": 30000},
            "temperature": {"min": 25, "max": 50},
        })

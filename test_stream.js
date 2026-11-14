// End-to-end diagnostic test for krx18-addon

async function testDiagnostic() {
  console.log("=== KRX18 ADDON DIAGNOSTIC TEST ===\n");

  const BASE = "http://localhost:7005";

  // 1. Manifest
  console.log("1. Checking Manifest...");
  const mRes = await fetch(`${BASE}/manifest.json`);
  if (!mRes.ok) throw new Error(`Manifest status ${mRes.status}`);
  const manifest = await mRes.json();
  console.log(`   Addon ID: ${manifest.id}, Name: ${manifest.name}, Version: ${manifest.version}`);
  console.log(`   Catalogs (${manifest.catalogs.length}):`);
  manifest.catalogs.forEach((c) => console.log(`     - [${c.id}] ${c.name}`));

  // 2. Test each catalog
  let testMovieId = null;
  for (const cat of manifest.catalogs) {
    console.log(`\n2. Testing Catalog: ${cat.name} (${cat.id})...`);
    const cRes = await fetch(`${BASE}/catalog/movie/${cat.id}.json`);
    if (!cRes.ok) {
      console.error(`   Failed to fetch ${cat.id}: status ${cRes.status}`);
      continue;
    }
    const catData = await cRes.json();
    console.log(`   Items returned: ${catData.metas?.length || 0}`);
    if (catData.metas?.length > 0) {
      console.log(`   First item: "${catData.metas[0].name}" -> ${catData.metas[0].id}`);
      if (!testMovieId) testMovieId = catData.metas[0].id;
    }
  }

  // 3. Test Meta
  if (testMovieId) {
    console.log(`\n3. Testing Meta for: ${testMovieId}...`);
    const metaRes = await fetch(`${BASE}/meta/movie/${encodeURIComponent(testMovieId)}.json`);
    const metaData = await metaRes.json();
    console.log(`   Meta title: "${metaData.meta?.name}"`);
    console.log(`   Poster: ${metaData.meta?.poster?.slice(0, 70)}...`);
    console.log(`   Genres: ${metaData.meta?.genres?.join(", ") || "None"}`);

    // 4. Test Stream Resolution
    console.log(`\n4. Testing Stream resolution for: ${testMovieId}...`);
    const streamRes = await fetch(`${BASE}/stream/movie/${encodeURIComponent(testMovieId)}.json`);
    const streamData = await streamRes.json();
    console.log(`   Streams count: ${streamData.streams?.length || 0}`);
    if (streamData.streams?.length > 0) {
      const stream = streamData.streams[0];
      console.log(`   Stream Title: "${stream.title}"`);
      console.log(`   Stream URL: ${stream.url}`);

      // 5. Test Proxy Playback
      console.log(`\n5. Testing Proxy stream fetch...`);
      const proxyRes = await fetch(stream.url);
      console.log(`   Proxy HTTP Status: ${proxyRes.status} ${proxyRes.statusText}`);
      console.log(`   Content-Type: ${proxyRes.headers.get("content-type")}`);
      const body = await proxyRes.text();
      console.log(`   Body preview (first 250 bytes):\n${body.slice(0, 250)}`);
      if (body.includes("#EXTM3U")) {
        console.log("\n>>> SUCCESS: M3U8 Master Playlist verified and playable! <<<");
      }
    }
  }

  console.log("\n=== ALL TESTS COMPLETED ===");
}

testDiagnostic().catch((e) => {
  console.error("\n❌ Diagnostic test failed:", e);
  process.exit(1);
});

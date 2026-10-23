// 本地 mock CMS：模拟苹果CMS采集接口（TVBox type=1 / type=0），用于验证"搜索→详情→播放"全链路
// 片源使用公共可达的测试视频（jsDelivr 上的 HLS/MP4 样例），不依赖任何盗版内容
const HOST = process.env.MOCK_HOST || 'http://127.0.0.1:8890';
const STREAM = {
  mp4: 'https://cdn.jsdelivr.net/gh/feiyang666999/testvideo/time/time.mp4',
  hls4k: 'https://cdn.jsdelivr.net/gh/feiyang666999/testvideo/sdr4kvideo/playlist.m3u8',
  hls2: 'https://cdn.jsdelivr.net/gh/feiyang666999/testvideo/hlg4kvideo/playlist.m3u8',
};

const VOD = [
  {
    id: 1001,
    name: '星际穿越 · 演示片',
    pic: '/assets/p1.svg',
    year: '2026', area: '内地', type: '科幻',
    remarks: '全12集', score: '9.4',
    actor: '演示演员A / 演示演员B', director: '演示导演',
    des: '【NovaTV 演示片单】用于验证平台的搜索、详情、线路切换与播放链路，全部使用公开测试流，不含任何版权内容。',
    classes: ['科幻', '剧情'],
  },
  {
    id: 1002,
    name: '流光之城 · 演示片',
    pic: '/assets/p2.svg',
    year: '2025', area: '内地', type: '都市',
    remarks: '更新至08集', score: '8.7',
    actor: '演示演员C', director: '演示导演',
    des: '【NovaTV 演示片单】多线路、多剧集结构演示。',
    classes: ['都市'],
  },
  {
    id: 1003,
    name: '深海回声 · 演示片',
    pic: '/assets/p3.svg',
    year: '2024', area: '内地', type: '悬疑',
    remarks: '全24集', score: '8.2',
    actor: '演示演员D', director: '演示导演',
    des: '【NovaTV 演示片单】用于验证搜索聚合排序与海报墙渲染。',
    classes: ['悬疑'],
  },
  {
    id: 1004,
    name: '山海食记 · 演示片',
    pic: '/assets/p4.svg',
    year: '2026', area: '内地', type: '纪录',
    remarks: '全06集', score: '9.0',
    actor: '—', director: '演示导演',
    des: '【NovaTV 演示片单】纪录片分类占位。',
    classes: ['纪录'],
  },
];

function episodes(prefix, urls) {
  return urls.map((u, i) => `${prefix}第${i + 1}集$${u}`).join('#');
}

function playUrlOf(v) {
  const lineA = episodes('', [STREAM.hls4k, STREAM.hls2, STREAM.mp4]);
  const lineB = episodes('', [STREAM.mp4, STREAM.hls4k]);
  return { from: 'nova_hls$$$nova_mp4', url: `${lineA}$$$${lineB}` };
}

function toItem(v, withPlay) {
  const base = {
    vod_id: v.id,
    vod_name: v.name,
    vod_pic: v.pic,
    vod_remarks: v.remarks,
    vod_year: v.year,
    vod_area: v.area,
    vod_class: v.type,
    vod_actor: v.actor,
    vod_director: v.director,
    vod_score: v.score,
    vod_content: v.des,
  };
  if (withPlay) Object.assign(base, { vod_play_from: playUrlOf(v).from, vod_play_url: playUrlOf(v).url });
  return base;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function handleMock(req, res, url) {
  const q = url.searchParams;
  const ac = q.get('ac') || 'list';
  const ids = q.get('ids');
  const wd = q.get('wd');
  const wantXml = q.get('at') === 'xml' || url.pathname.endsWith('.xml');

  let list = VOD;
  if (ids) list = VOD.filter((v) => String(v.id) === String(ids));
  else if (wd) list = VOD.filter((v) => v.name.includes(wd) || v.type.includes(wd) || v.des.includes(wd));

  const withPlay = ac === 'videolist' || Boolean(ids) || Boolean(wd);

  if (wantXml) {
    const body = `<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="1" pagecount="1" pagesize="20" recordcount="${list.length}">${list
      .map((v) => {
        const p = playUrlOf(v);
        const dl = p.from
          .split('$$$')
          .map((f, i) => `<dd flag="${f}"><![CDATA[${p.url.split('$$$')[i]}]]></dd>`)
          .join('');
        return `<video><id>${v.id}</id><name><![CDATA[${v.name}]]></name><pic>${xmlEscape(v.pic)}</pic><year>${v.year}</year><area>${v.area}</area><type>${v.type}</type><note><![CDATA[${v.remarks}]]></note><actor><![CDATA[${v.actor}]]></actor><director><![CDATA[${v.director}]]></director><des><![CDATA[${v.des}]]></des><dl>${dl}</dl></video>`;
      })
      .join('')}</list></rss>`;
    return send(res, 200, 'application/xml; charset=utf-8', body);
  }

  const payload = {
    code: 1,
    msg: '数据列表',
    page: 1,
    pagecount: 1,
    limit: '20',
    total: list.length,
    class: [
      { type_id: 1, type_name: '科幻' },
      { type_id: 2, type_name: '都市' },
      { type_id: 3, type_name: '悬疑' },
      { type_id: 4, type_name: '纪录' },
    ],
    list: list.map((v) => toItem(v, withPlay)),
  };
  if (ac !== 'videolist' && !ids && !wd) payload.list = list.map((v) => toItem(v, false));
  return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

export const mockBase = `${HOST}/mock/api.php/provide/vod/`;

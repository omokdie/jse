#!/usr/bin/env python3
"""Korean lyrics for the synthetic score corpus (used by gen_lyrics_corpus.py
through the `lyricHook` of gen_synthetic.render_measure).

Text: original children's-song style lines written for JSE, traditional folk
song lines (public domain) and a small phrase generator, so syllable
sequences look like real lyrics. One Hangul syllable per note; rests and tied
continuation notes get none (same convention as the editor). Some phrases end
with punctuation (",", ".", "!", "?", "~") attached to their last syllable;
pages may carry a second verse and leading verse numbers ("1.", "2.").

Ground truth: every note event that received a syllable gets
  lyrics: [{verse, text, bbox:[x,y,w,h]}]
in the page JSON (bbox = ink box of the rendered syllable incl. punctuation).
"""
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ORIGINAL_LINES = [
    '봄바람 불어오면 꽃잎이 춤을 춰요', '새들 노래 들려와 우리 함께 걸어요',
    '하늘 높이 날아라 작은 종이비행기', '시냇물이 졸졸졸 노래하며 흘러가요',
    '달님 달님 둥근 달님 우리 집에 놀러 와요', '아침 해가 반짝 떠오르면 기지개를 켜요',
    '빨간 사과 노란 바나나 맛있는 과일 친구', '우리 엄마 손은 약손 아픈 배를 쓸어 줘요',
    '눈이 펑펑 내리는 날 눈사람을 만들어요', '구름 위에 앉아서 세상 구경 하고 싶어',
    '작은 씨앗 하나 심고 물을 주고 기다려요', '바닷가에 모래성 파도가 와서 놀자 해요',
    '숲속 작은 오솔길에 다람쥐가 뛰어가요', '별빛 가득한 밤하늘 소원 하나 빌어 봐요',
    '노란 우산 쓰고 가는 비 오는 날 학교 길', '할머니 댁 마당에는 강아지가 살고 있죠',
    '친구야 같이 가자 손을 잡고 노래하며', '가을바람 솔솔 불면 단풍잎이 물들어요',
    '꿈나라로 가는 기차 칙칙폭폭 달려가요', '무지개 다리 건너서 먼 나라로 떠나 봐요',
    '고마운 마음 담아서 편지 한 장 써 볼까요', '햇님 방긋 웃는 아침 꽃들이 인사해요',
    '동그란 얼굴 예쁜 미소 우리 아기 잘도 자요', '들판에는 나비 춤 하늘에는 새들 노래',
    '반딧불이 깜빡깜빡 여름밤을 밝혀 줘요', '우리 모두 손뼉 치며 즐겁게 노래 불러요',
    '산 너머 저 멀리 뭉게구름 피어나네', '겨울밤 따뜻한 방 군고구마 냄새 솔솔',
    '엄마 품에 안겨서 자장자장 잠이 들죠', '푸른 바다 고래 가족 물을 뿜고 헤엄쳐요',
    '봄이 오면 개나리 진달래 활짝 피어요', '즐거운 소풍 날 도시락 들고 떠나요',
    '우리들의 꿈은 저 하늘처럼 높고 넓어', '나뭇잎 배 띄워 보내 멀리멀리 가거라',
    '종소리 울려 퍼지는 기쁜 성탄 밤이에요', '새해 아침 떡국 한 그릇 한 살 더 먹었어요',
    '사랑해요 고마워요 오늘도 행복해요', '꽃밭에 앉아서 꽃잎을 세어 봐요',
    '뻐꾸기 우는 소리 산골짜기 메아리', '귀여운 토끼 한 마리 깡충깡충 뛰어가요',
    '파란 하늘 흰 구름 바람 따라 흘러가네', '냇가에 앉아 발 담그고 물장구를 쳐요',
    '닭 울음소리 들리면 넓은 들판 붉게 물드네', '읽던 책을 덮고서 창밖을 내다봐요',
    '많이 많이 웃어요 괜찮아 다 잘될 거야', '젊은 날의 꿈들이 별처럼 빛났었지',
    '흙 묻은 손 씻고 와 따뜻한 밥 먹자', '앉은뱅이 꽃 한 송이 길가에 피었네',
    '꿇어앉아 두 손 모아 기도를 드려요', '뒷동산에 올라가 연을 높이 띄웠지',
    '쉿 조용히 해요 아기가 잠을 자요', '왔다 갔다 시계추 똑딱똑딱 바빠요',
]
# traditional folk songs (anonymous, public domain)
FOLK_LINES = [
    '아리랑 아리랑 아라리요 아리랑 고개로 넘어간다', '나를 버리고 가시는 님은 십리도 못 가서 발병 난다',
    '도라지 도라지 백도라지 심심산천에 백도라지', '한두 뿌리만 캐어도 대바구니로 반실만 되누나',
    '새야 새야 파랑새야 녹두밭에 앉지 마라', '녹두꽃이 떨어지면 청포장수 울고 간다',
    '강강술래 강강술래 달 떠 온다 달 떠 온다', '옹헤야 어절씨구 옹헤야 저절씨구 옹헤야',
    '천안 삼거리 흥 능수야 버들은 흥', '쾌지나 칭칭 나네 쾌지나 칭칭 나네',
]
NOUNS = ['하늘', '바다', '구름', '바람', '나무', '꽃잎', '별님', '달님', '햇살', '친구', '엄마', '아빠', '동생', '마음', '노래',
         '웃음', '사랑', '꿈', '새', '나비', '강물', '산', '들판', '마을', '길', '손', '눈', '비', '봄', '여름', '가을', '겨울',
         '시냇물', '무지개', '아기', '고향', '기차', '풀잎', '이슬', '물결', '등불', '종소리', '꽃씨', '우리', '얼굴', '편지']
ADJ = ['작은', '예쁜', '푸른', '하얀', '빨간', '노란', '따뜻한', '시원한', '고운', '맑은', '커다란', '귀여운', '반가운', '조그만', '즐거운', '포근한']
VERBS = ['노래해요', '춤을 춰요', '반짝여요', '흘러가요', '웃어요', '날아가요', '피어나요', '불어와요', '놀아요', '잠들어요', '기다려요',
         '빛나요', '속삭여요', '달려가요', '그리워요', '좋아해요', '만나요', '손짓해요', '찾아와요', '꿈꿔요', '인사해요', '반겨 줘요']
PARTICLES = {'subj': ('이', '가'), 'top': ('은', '는'), 'obj': ('을', '를'), 'with': ('과', '와'), 'loc': ('에', '에'),
             'like': ('처럼', '처럼'), 'also': ('도', '도'), 'from': ('에서', '에서')}


def has_final(word):
    c = ord(word[-1]) - 0xAC00
    return 0 <= c < 11172 and c % 28 != 0


def particle(word, kind):
    a, b = PARTICLES[kind]
    return word + (a if has_final(word) else b)


def make_phrase(rng):
    parts = []
    if rng.random() < 0.6:
        parts.append(rng.choice(ADJ))
    parts.append(particle(rng.choice(NOUNS), rng.choice(['subj', 'top', 'loc', 'with', 'like', 'also', 'from'])))
    if rng.random() < 0.5:
        if rng.random() < 0.4:
            parts.append(rng.choice(ADJ))
        parts.append(particle(rng.choice(NOUNS), rng.choice(['obj', 'subj', 'loc'])))
    parts.append(rng.choice(VERBS))
    return ' '.join(parts)


class SyllableStream:
    """Endless stream of (syllable text) built from lyric lines/phrases;
    phrase-final syllables sometimes carry punctuation."""

    def __init__(self, rng, punct_prob=0.25):
        self.rng = rng
        self.queue = []
        self.punct_prob = punct_prob

    def _refill(self):
        r = self.rng.random()
        line = self.rng.choice(ORIGINAL_LINES) if r < 0.55 else self.rng.choice(FOLK_LINES) if r < 0.7 else make_phrase(self.rng)
        syl = [ch for ch in line if ch != ' ']
        if syl and self.rng.random() < self.punct_prob:
            syl[-1] += self.rng.choice([',', ',', '.', '.', '!', '?', '~'])
        self.queue.extend(syl)

    def next(self):
        while not self.queue:
            self._refill()
        return self.queue.pop(0)


NOTO = '/usr/share/fonts/opentype/noto/'
KOREAN_FONTS = [
    ('serif-regular', NOTO + 'NotoSerifCJK-Regular.ttc', 1), ('serif-medium', NOTO + 'NotoSerifCJK-Medium.ttc', 1),
    ('serif-light', NOTO + 'NotoSerifCJK-Light.ttc', 1), ('serif-semibold', NOTO + 'NotoSerifCJK-SemiBold.ttc', 1),
    ('sans-regular', NOTO + 'NotoSansCJK-Regular.ttc', 1), ('sans-demilight', NOTO + 'NotoSansCJK-DemiLight.ttc', 1),
    ('sans-medium', NOTO + 'NotoSansCJK-Medium.ttc', 1), ('sans-bold', NOTO + 'NotoSansCJK-Bold.ttc', 1),
    ('wqy-zenhei', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 0),
]


class KoreanLyrics:
    """Renders Korean lyrics under the notes of one staff (lyricHook)."""

    def __init__(self, rng, sp, verses=1, font=None, em_sp=None, verse_numbers=None):
        self.rng = rng
        self.sp = sp
        self.verses = verses
        name, path, idx = font or rng.choice(KOREAN_FONTS)
        self.font_name = name
        self.em = max(9, int(round((em_sp or rng.uniform(1.45, 2.05)) * sp)))
        self.font = ImageFont.truetype(path, self.em, index=idx)
        self.gap_sp = rng.uniform(2.1, 2.7)                 # bottom line -> glyph top of verse 1
        self.pitch = self.em * rng.uniform(1.28, 1.5)        # verse line pitch (px)
        self.streams = [SyllableStream(random.Random(rng.randrange(1 << 30))) for _ in range(verses)]
        self.verse_numbers = (verses > 1 and rng.random() < 0.6) if verse_numbers is None else verse_numbers
        self.first = True
        self.count = 0

    def space_sp(self):
        """Vertical room the lyrics need below the staff (staff spaces)."""
        return self.gap_sp + (self.em * 1.05 + (self.verses - 1) * self.pitch) / self.sp + 0.6

    def _mask(self, text):
        f = self.font
        l, t, r, b = f.getbbox(text, anchor='ls')
        w, h = r - l + 4, b - t + 4
        im = Image.new('L', (w, h), 0)
        ImageDraw.Draw(im).text((2 - l, 2 - t), text, font=f, fill=255, anchor='ls')
        a = np.asarray(im, np.float32) / 255.0
        return a, 2 - l, 2 - t                                # mask, pen origin inside the mask

    def draw(self, pg, text, cx, baseline, align_text=None):
        """Draws `text` with the ink of `align_text` (default: the whole text,
        without trailing punctuation) centred at cx; returns the ink bbox."""
        from music_glyphs import blit
        a, ox, oy = self._mask(text)
        key = align_text if align_text is not None else text.rstrip(',.!?~')
        if key and key != text:
            ak, kx, _ = self._mask(key)
            cols = np.nonzero(ak.max(axis=0) > 0.3)[0]
            kc = (cols[0] + cols[-1] + 1) / 2 - kx if len(cols) else 0
        else:
            cols = np.nonzero(a.max(axis=0) > 0.3)[0]
            kc = (cols[0] + cols[-1] + 1) / 2 - ox if len(cols) else 0
        x = int(round(cx - kc - ox))
        y = int(round(baseline - oy))
        blit(pg.img, a, x, y)
        ys, xs = np.nonzero(a > 0.3)
        if not len(xs):
            return None
        return [float(x + xs.min()), float(y + ys.min()), float(xs.max() - xs.min() + 1), float(ys.max() - ys.min() + 1)]

    def hook(self, pg, events, gt_events, xs, top):
        sp = self.sp
        base0 = top + 4 * sp + self.gap_sp * sp + 0.86 * self.em      # baseline of verse 1
        for i, ev in enumerate(events):
            if ev['kind'] != 'note' or ev.get('tieEnd'):
                continue
            entries = []
            for v in range(self.verses):
                text = self.streams[v].next()
                cx = xs[i] + self.rng.uniform(-0.12, 0.12) * sp
                bl = base0 + v * self.pitch
                bb = self.draw(pg, text, cx, bl)
                if bb:
                    entries.append({'verse': v + 1, 'text': text, 'bbox': bb})
                if self.first and self.verse_numbers:
                    num = f'{v + 1}.'
                    a, ox, oy = self._mask(num)
                    syl_w = (bb[2] if bb else self.em)
                    nx = int(round(cx - syl_w / 2 - 0.45 * self.em - a.shape[1]))
                    from music_glyphs import blit
                    blit(pg.img, a, nx, int(round(bl - oy)))
            self.first = False
            self.count += 1
            if entries:
                gt_events[i]['lyrics'] = entries

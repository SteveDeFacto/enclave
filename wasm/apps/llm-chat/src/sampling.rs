//! Token sampling: greedy at temperature 0, otherwise temperature +
//! top-k/top-p over softmaxed logits, with the repetition penalty applied
//! first. The RNG is a small xorshift seeded per-request from the clock -
//! sampling noise, not cryptography (the platform's wasi:random stays for
//! things that matter).

pub struct SampleParams {
    pub temperature: f32, // 0 = greedy
    pub top_p: f32,       // nucleus; 1.0 = off
    pub top_k: usize,     // 0 = off
    pub rep_penalty: f32,
    pub rep_window: usize,
}

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed | 1)
    }
    fn next_f32(&mut self) -> f32 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        let v = x.wrapping_mul(0x2545F4914F6CDD1D) >> 40;
        (v as f32) / ((1u64 << 24) as f32)
    }
}

pub fn pick_token(logits: &mut [f32], recent: &[u32], p: &SampleParams, rng: &mut Rng) -> u32 {
    for &t in recent {
        if let Some(l) = logits.get_mut(t as usize) {
            if *l > 0.0 {
                *l /= p.rep_penalty;
            } else {
                *l *= p.rep_penalty;
            }
        }
    }
    if p.temperature <= 0.0 {
        let mut best = 0usize;
        let mut best_v = f32::NEG_INFINITY;
        for (i, &v) in logits.iter().enumerate() {
            if v > best_v {
                best_v = v;
                best = i;
            }
        }
        return best as u32;
    }
    // temperature + top-k prefilter: sort a bounded candidate set instead of
    // the whole vocab (151936 floats) - top 256 covers any sane top_p mass
    let k = if p.top_k > 0 { p.top_k.min(256) } else { 256 };
    let mut cand: Vec<(usize, f32)> = Vec::with_capacity(k + 1);
    let mut min_in = f32::NEG_INFINITY;
    for (i, &v) in logits.iter().enumerate() {
        if v > min_in || cand.len() < k {
            cand.push((i, v));
            if cand.len() > k {
                // drop the current minimum
                let (mi, _) = cand
                    .iter()
                    .enumerate()
                    .min_by(|a, b| a.1 .1.partial_cmp(&b.1 .1).unwrap())
                    .map(|(idx, &(i2, v2))| (idx, (i2, v2)))
                    .unwrap();
                cand.swap_remove(mi);
                min_in = cand
                    .iter()
                    .map(|&(_, v2)| v2)
                    .fold(f32::INFINITY, f32::min);
            }
        }
    }
    cand.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    // softmax at temperature over the candidates
    let max_l = cand[0].1;
    let mut probs: Vec<f32> = cand
        .iter()
        .map(|&(_, v)| ((v - max_l) / p.temperature).exp())
        .collect();
    let sum: f32 = probs.iter().sum();
    for q in probs.iter_mut() {
        *q /= sum;
    }
    // nucleus cut
    let mut cut = probs.len();
    if p.top_p < 1.0 {
        let mut acc = 0.0;
        for (i, &q) in probs.iter().enumerate() {
            acc += q;
            if acc >= p.top_p {
                cut = i + 1;
                break;
            }
        }
    }
    let mass: f32 = probs[..cut].iter().sum();
    let mut r = rng.next_f32() * mass;
    for i in 0..cut {
        r -= probs[i];
        if r <= 0.0 {
            return cand[i].0 as u32;
        }
    }
    cand[0].0 as u32
}

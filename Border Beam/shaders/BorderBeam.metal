//
//  BorderBeam.metal
//
//  Port of github.com/ismnoiet/border-beam-ios (MIT) to a Scripting/SwiftUI
//  colorEffect shader. One GPU pass draws the whole beam: the crisp ring that
//  hugs the border plus the soft inner glow.
//
//  Differences from the original:
//   - the palette arrives as five float4 RGBA values (Scripting manifest format
//     has no float-array argument), colorCount says how many are used;
//   - the view rect arrives through the boundingRect argument instead of a size float2.
//
#include <metal_stdlib>
using namespace metal;

// Signed distance to a rounded box centred at the origin (negative inside).
static float bbSdRoundedBox(float2 p, float2 hs, float r) {
    float2 q = abs(p) - (hs - r);
    return length(max(q, float2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Position along the border, measured clockwise from the right-edge midpoint, 0...1.
// Distance ALONG the edge (not the angle around the centre) keeps the beam ends
// perpendicular to the border, so the glow never fans out toward the centre.
static float bbPerimeterParam(float2 p, float2 hs, float r) {
    float2 ih = max(hs - r, float2(0.0));
    float arc = M_PI_F * r * 0.5;
    float L = 4.0 * ih.x + 4.0 * ih.y + 4.0 * arc;
    float baseBL = ih.y + arc + 2.0 * ih.x;
    float baseL = baseBL + arc;
    float baseTL = baseL + 2.0 * ih.y;
    float baseTR = baseTL + arc + 2.0 * ih.x;
    float2 ap = abs(p);
    float s;
    if (ap.x > ih.x && ap.y > ih.y) {
        float2 v = ap - ih;
        float ang = atan2(v.y, v.x);
        if (p.x >= 0.0 && p.y >= 0.0) {
            s = ih.y + r * ang;
        } else if (p.x < 0.0 && p.y >= 0.0) {
            s = baseBL + r * (M_PI_F * 0.5 - ang);
        } else if (p.x < 0.0) {
            s = baseTL + r * ang;
        } else {
            s = baseTR + r * (M_PI_F * 0.5 - ang);
        }
    } else if ((hs.x - ap.x) < (hs.y - ap.y)) {
        if (p.x >= 0.0) {
            s = p.y >= 0.0 ? p.y : L + p.y;
        } else {
            s = baseL + (ih.y - p.y);
        }
    } else {
        if (p.y >= 0.0) {
            s = ih.y + arc + (ih.x - p.x);
        } else {
            s = baseTL + arc + (p.x + ih.x);
        }
    }
    return fract(s / max(L, 0.001));
}

// Inverse of bbPerimeterParam: the point on the border at distance s (points),
// clockwise from the right-edge midpoint.
static float2 bbBoundaryPoint(float s, float2 hs, float r) {
    float2 ih = max(hs - r, float2(0.0));
    float arc = M_PI_F * r * 0.5;
    float L = 4.0 * ih.x + 4.0 * ih.y + 4.0 * arc;
    float invR = 1.0 / max(r, 0.001);
    s = s - L * floor(s / max(L, 0.001));
    float l;

    l = ih.y;       if (s < l) { return float2(hs.x, s); }                                    s -= l;
    l = arc;        if (s < l) { float a = s * invR;                return float2( ih.x,  ih.y) + r * float2(cos(a), sin(a)); } s -= l;
    l = 2.0 * ih.x; if (s < l) { return float2(ih.x - s, hs.y); }                             s -= l;
    l = arc;        if (s < l) { float a = M_PI_F * 0.5 + s * invR; return float2(-ih.x,  ih.y) + r * float2(cos(a), sin(a)); } s -= l;
    l = 2.0 * ih.y; if (s < l) { return float2(-hs.x, ih.y - s); }                            s -= l;
    l = arc;        if (s < l) { float a = M_PI_F + s * invR;      return float2(-ih.x, -ih.y) + r * float2(cos(a), sin(a)); } s -= l;
    l = 2.0 * ih.x; if (s < l) { return float2(-ih.x + s, -hs.y); }                           s -= l;
    l = arc;        if (s < l) { float a = M_PI_F * 1.5 + s * invR; return float2( ih.x, -ih.y) + r * float2(cos(a), sin(a)); } s -= l;
    return float2(hs.x, -ih.y + s);
}

// Linear blend across the palette. t in 0...1, samples 0...n-1.
static float4 bbPalette(float4 c0, float4 c1, float4 c2, float4 c3, float4 c4, int n, float t) {
    float4 c[5] = { c0, c1, c2, c3, c4 };
    if (n <= 0) { return float4(1.0); }
    if (n == 1) { return c[0]; }
    float x = clamp(t, 0.0, 1.0) * float(n - 1);
    int i = min(int(floor(x)), n - 2);
    float f = x - float(i);
    return mix(c[i], c[i + 1], f);
}

// Soft glow of the orbiting beam = a chain of round Gaussian blobs laid along the
// beam path on the border (like blurring a stroke). It never asks which edge is
// nearest, so it cannot make seams, triangles or inset rectangles, and corners come
// out naturally round on any shape.
static float4 bbOrbitGlowBlobs(float2 p, float dist, float2 hs, float r, float phase,
                               float direction, float arcLen, float sigmaBase,
                               float4 c0, float4 c1, float4 c2, float4 c3, float4 c4, int count) {
    float2 ih = max(hs - r, float2(0.0));
    float cornerArc = M_PI_F * r * 0.5;
    float L = 4.0 * ih.x + 4.0 * ih.y + 4.0 * cornerArc;

    const int K = 24;
    float delta = arcLen * L / float(K);
    float sigma = max(sigmaBase, 0.8 * delta);
    if (dist > 3.0 * sigma) { return float4(0.0); }
    float inv2s2 = 0.5 / (sigma * sigma);
    float norm = delta / (sigma * 2.50663);

    float start = 1.0 - arcLen;
    float4 acc = float4(0.0);
    for (int k = 0; k < K; k++) {
        float t = (float(k) + 0.5) / float(K);
        float sp = fract(start + t * arcLen + direction * phase);
        float2 pt = bbBoundaryPoint(sp * L, hs, r);
        float2 dv = p - pt;
        float g = exp(-dot(dv, dv) * inv2s2);
        if (g < 0.003) { continue; }
        float bell = pow(sin(M_PI_F * t), 1.6);
        float4 cc = bbPalette(c0, c1, c2, c3, c4, count, t);
        float v = g * norm * bell * clamp(cc.a, 0.0, 1.0);
        acc += float4(cc.rgb * v, v);
    }
    return acc;
}

[[ stitchable ]] half4 borderBeam(
    float2 position,
    half4 inColor,
    float4 bounds,
    float cornerRadius,
    float phase,
    float direction,
    float mode,
    float side,
    float arcLen,
    float glow,
    float intensity,
    float4 c0,
    float4 c1,
    float4 c2,
    float4 c3,
    float4 c4,
    float colorCount
) {
    float2 size = bounds.zw;
    float2 hs = size * 0.5;
    if (hs.x < 1.0 || hs.y < 1.0) { return half4(0.0); }

    float r = min(cornerRadius, min(hs.x, hs.y));
    float2 p = position - bounds.xy - hs;
    int count = int(clamp(colorCount + 0.5, 1.0, 5.0));

    float dist = -bbSdRoundedBox(p, hs, r);
    if (dist < 0.0) { return half4(0.0); }

    float4 acc = float4(0.0);

    if (mode < 0.5) {
        float a = bbPerimeterParam(p, hs, r);
        float tt = (fract(a - direction * phase) - (1.0 - arcLen)) / arcLen;
        if (tt >= 0.0) {
            float profile = pow(sin(M_PI_F * clamp(tt, 0.0, 1.0)), 1.2);
            float crisp = 1.0 - smoothstep(0.5, 2.25, dist);
            float halo = 0.6 * exp(-dist / max(glow * 0.1, 0.6));
            float4 cc = bbPalette(c0, c1, c2, c3, c4, count, tt);
            float w = (crisp + halo) * profile * clamp(cc.a, 0.0, 1.0);
            acc += float4(cc.rgb * w, w);
        }
        acc += 0.55 * bbOrbitGlowBlobs(p, dist, hs, r, phase, direction, arcLen,
                                       max(glow, 0.001) * 0.7,
                                       c0, c1, c2, c3, c4, count);
    } else {
        float u;
        float edgeDist;
        int s = int(side + 0.5);
        if (s == 1)      { u = position.x / size.x; edgeDist = position.y; }
        else if (s == 2) { u = position.x / size.x; edgeDist = size.y - position.y; }
        else if (s == 3) { u = position.y / size.y; edgeDist = position.x; }
        else             { u = position.y / size.y; edgeDist = size.x - position.x; }

        float len = 0.28;
        float tri = phase < 0.5 ? phase * 2.0 : (1.0 - phase) * 2.0;
        float eased = tri * tri * (3.0 - 2.0 * tri);
        float c = len * 0.5 + (1.0 - len) * eased;
        float k = (u - (c - len * 0.5)) / len;
        if (k < 0.0 || k > 1.0) { return half4(0.0); }
        float tp = 1.0 - abs(2.0 * k - 1.0);
        float profile = tp * tp * (3.0 - 2.0 * tp);
        float4 cc = bbPalette(c0, c1, c2, c3, c4, count, k);

        float crisp = 1.0 - smoothstep(0.5, 2.25, edgeDist);
        float halo = 0.8 * exp(-edgeDist / max(glow * 0.2, 0.5));
        float wide = 0.6 * exp(-pow(edgeDist / max(glow, 0.001), 1.4));
        float w = ((crisp + halo) * profile + wide * profile) * clamp(cc.a, 0.0, 1.0);
        acc += float4(cc.rgb * w, w);
    }

    float total = acc.a;
    if (total <= 0.0001) { return half4(0.0); }
    float3 rgb = acc.rgb / total;
    float a = clamp(total * intensity, 0.0, 1.0);
    return half4(half3(rgb) * half(a), half(a));
}

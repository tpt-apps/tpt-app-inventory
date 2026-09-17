//! WASM bindings for TPT Inventory — a warehouse/shop barcode counting app
//! built on the [`tpt-barcode`](https://github.com/tpt-solutions/tpt-barcode)
//! engine.
//!
//! Exposes [`scan_rgba`] (decode a camera frame, any supported symbology —
//! SKU labels in the wild are QR, DataMatrix, Code128, Code39, EAN-13 or
//! UPC-A depending on the shop) and nothing else; this app is decode-only.

use tpt_barcode::core::{DecodeError, Format};
use wasm_bindgen::prelude::*;

fn js_err<E: core::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// A single decoded barcode, returned from [`scan_rgba`].
#[wasm_bindgen]
pub struct WasmScanResult {
    text: String,
    format: &'static str,
}

#[wasm_bindgen]
impl WasmScanResult {
    /// The decoded text payload (UTF-8) — the SKU/code for inventory use.
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.text.clone()
    }

    /// The barcode symbology, e.g. `"Code 128"`, `"EAN-13"`.
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.format.to_string()
    }
}

fn format_name(format: Format) -> &'static str {
    match format {
        Format::QrCode => "QR Code",
        Format::DataMatrix => "Data Matrix",
        Format::Pdf417 => "PDF417",
        Format::Code128 => "Code 128",
        Format::Ean13 => "EAN-13",
        Format::UpcA => "UPC-A",
        Format::Code39 => "Code 39",
    }
}

fn all_formats() -> [Format; 6] {
    [
        Format::QrCode,
        Format::DataMatrix,
        Format::Code128,
        Format::Ean13,
        Format::UpcA,
        Format::Code39,
    ]
}

/// Scan an RGBA image buffer (e.g. straight from a `<canvas>` `ImageData`)
/// for any supported barcode. Internally converts to grayscale before
/// scanning.
///
/// `pixels.len()` must equal `width * height * 4`. Returns an array of
/// [`WasmScanResult`] (empty if nothing was found this frame — not an error,
/// since this runs against a live camera feed).
#[wasm_bindgen]
pub fn scan_rgba(pixels: &[u8], width: u32, height: u32) -> Result<Vec<WasmScanResult>, JsValue> {
    let expected = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    if pixels.len() != expected {
        return Err(JsValue::from_str(
            "scan_rgba: pixels.len() must equal width * height * 4",
        ));
    }

    let mut gray = Vec::with_capacity((width as usize) * (height as usize));
    for chunk in pixels.chunks_exact(4) {
        let (r, g, b) = (chunk[0] as u32, chunk[1] as u32, chunk[2] as u32);
        let y = (r * 299 + g * 587 + b * 114) / 1000;
        gray.push(y as u8);
    }

    let formats = all_formats();
    let results = tpt_barcode::scan(&gray, width as usize, height as usize)
        .formats(&formats)
        .try_harder(true)
        .execute();

    match results {
        Ok(hits) => Ok(hits
            .into_iter()
            .map(|r| WasmScanResult {
                text: r.text().to_string(),
                format: format_name(r.format()),
            })
            .collect()),
        Err(DecodeError::NotFound) => Ok(Vec::new()),
        Err(other) => Err(js_err(other)),
    }
}

/// Called once by the JS glue on module init; wires up panic messages to the
/// browser console so failures are easier to diagnose than a bare "unreachable".
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: encode a Code128 barcode, rasterize it the way a
    /// `<canvas>` frame would look, and confirm `scan_rgba` decodes the same
    /// SKU back out. This is the actual path the inventory scanner relies on.
    #[test]
    fn scan_rgba_round_trips_a_generated_code128_sku() {
        let sku = "SKU-00123";
        let code = tpt_barcode::one_d::code128::encode_b(sku.as_bytes()).unwrap();

        let module_px = 3u32;
        let bar_height = 60u32;
        let quiet = 10u32;
        let total_width: u32 = code.modules.iter().map(|&w| w as u32 * module_px).sum();
        let img_w = total_width + 2 * quiet;
        let img_h = bar_height + 2 * quiet;

        let mut rgba = vec![255u8; (img_w * img_h * 4) as usize];
        let mut x = quiet;
        let mut is_bar = true;
        for &width in &code.modules {
            let px = width as u32 * module_px;
            if is_bar {
                for dy in 0..bar_height {
                    for dx in 0..px {
                        let xx = x + dx;
                        let yy = quiet + dy;
                        let idx = ((yy * img_w + xx) * 4) as usize;
                        rgba[idx] = 0;
                        rgba[idx + 1] = 0;
                        rgba[idx + 2] = 0;
                        rgba[idx + 3] = 255;
                    }
                }
            }
            x += px;
            is_bar = !is_bar;
        }

        let hits = scan_rgba(&rgba, img_w, img_h).expect("scan should not error");
        assert_eq!(hits.len(), 1, "expected exactly one Code128 hit");
        assert_eq!(hits[0].text(), sku);
        assert_eq!(hits[0].format(), "Code 128");
    }
}

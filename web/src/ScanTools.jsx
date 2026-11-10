import { useEffect, useRef, useState } from "react";

export function InlineCameraScan({ area }) {
  const [scanUrl, setScanUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (scanUrl) URL.revokeObjectURL(scanUrl);
  }, [scanUrl]);

  const receiveScan = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    setError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image from the camera or device.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("Image is larger than 15 MB. Capture a smaller image and retry.");
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setScanUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return nextUrl;
    });
    setFileName(file.name || "Camera scan");
  };

  return (
    <div className="inline-camera-scan">
      <div className="inline-camera-copy">
        <strong>Camera scan · {area}</strong>
        <span>Capture a document image here, inside this page. Desktop users can select an image file.</span>
      </div>
      <label className="scan-secondary-button">
        ⌁ Scan / attach image
        <input type="file" accept="image/*" capture="environment" onChange={receiveScan} />
      </label>
      {scanUrl && (
        <div className="inline-camera-preview">
          <img src={scanUrl} alt={"Captured scan for " + area} />
          <span>{fileName}</span>
          <a href={scanUrl} download={(area || "pwfb") + "-scan.jpg"}>Download image</a>
          <button type="button" onClick={() => {
            URL.revokeObjectURL(scanUrl);
            setScanUrl("");
            setFileName("");
          }}>Remove</button>
        </div>
      )}
      {error && <p className="scan-error" role="alert">{error}</p>}
    </div>
  );
}

async function buildScannedPdf(pages) {
  const encoder = new TextEncoder();
  const prepared = [];

  for (const page of pages) {
    const image = new Image();
    image.src = page.src;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("A scanned image could not be read."));
    });

    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, 1800 / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const rotation = ((Number(page.rotation) || 0) % 360 + 360) % 360;
    const canvas = document.createElement("canvas");
    canvas.width = rotation % 180 === 90 ? height : width;
    canvas.height = rotation % 180 === 90 ? width : height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare a PDF page.");
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(image, -width / 2, -height / 2, width, height);

    const base64 = canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    const binary = atob(base64);
    const jpeg = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      jpeg[index] = binary.charCodeAt(index);
    }
    prepared.push({ width: canvas.width, height: canvas.height, jpeg });
  }

  const chunks = [];
  let byteOffset = 0;
  const offsets = [];
  const append = (value) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    byteOffset += bytes.length;
  };
  const addObject = (id, parts) => {
    offsets[id] = byteOffset;
    append(id + " 0 obj\n");
    parts.forEach(append);
    append("\nendobj\n");
  };

  append(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10]));
  const pageIds = prepared.map((_, index) => 3 + index * 3);
  addObject(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  addObject(2, [
    "<< /Type /Pages /Kids [" + pageIds.map((id) => id + " 0 R").join(" ") +
    "] /Count " + prepared.length + " >>",
  ]);

  prepared.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const fitScale = Math.min(595 / page.width, 842 / page.height);
    const drawWidth = page.width * fitScale;
    const drawHeight = page.height * fitScale;
    const x = (595 - drawWidth) / 2;
    const y = (842 - drawHeight) / 2;
    const stream = "q " + drawWidth.toFixed(3) + " 0 0 " + drawHeight.toFixed(3) +
      " " + x.toFixed(3) + " " + y.toFixed(3) + " cm /Im0 Do Q";

    addObject(pageId, [
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /XObject << /Im0 " + imageId + " 0 R >> >> " +
      "/Contents " + contentId + " 0 R >>",
    ]);
    addObject(imageId, [
      "<< /Type /XObject /Subtype /Image /Width " + page.width +
      " /Height " + page.height +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode " +
      "/Length " + page.jpeg.length + " >>\nstream\n",
      page.jpeg,
      "\nendstream",
    ]);
    const contentBytes = encoder.encode(stream);
    addObject(contentId, [
      "<< /Length " + contentBytes.length + " >>\nstream\n",
      contentBytes,
      "\nendstream",
    ]);
  });

  const xrefOffset = byteOffset;
  const objectCount = 3 + prepared.length * 3;
  append("xref\n0 " + objectCount + "\n0000000000 65535 f \n");
  for (let id = 1; id < objectCount; id += 1) {
    append(String(offsets[id]).padStart(10, "0") + " 00000 n \n");
  }
  append(
    "trailer\n<< /Size " + objectCount + " /Root 1 0 R >>\n" +
    "startxref\n" + xrefOffset + "\n%%EOF"
  );
  return new Blob(chunks, { type: "application/pdf" });
}

export function ScanToTextPage() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [extractedText, setExtractedText] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [working, setWorking] = useState(false);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  };

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const startCamera = async () => {
    setMessage("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is unavailable. Upload an image instead.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (error) {
      setMessage(error.message || "Could not start the camera. Check browser permission.");
    }
  };

  const recognizeImage = async (file) => {
    if (!file || !file.type.startsWith("image/")) {
      setMessage("Choose an image from your camera or device.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setMessage("The image is larger than 20 MB. Choose a smaller image.");
      return;
    }
    setWorking(true);
    setProgress(0);
    setMessage("Preparing OCR…");
    setFileName(file.name || "Camera capture");
    setExtractedText("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    try {
      const Tesseract = await new Promise((resolve, reject) => {
        if (window.Tesseract) return resolve(window.Tesseract);
        const existing = document.querySelector('script[data-pwfb-ocr="true"]');
        if (existing) {
          existing.addEventListener("load", () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR engine failed to start.")), { once: true });
          existing.addEventListener("error", () => reject(new Error("Could not load OCR. Check your internet connection and retry.")), { once: true });
          return;
        }
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        script.dataset.pwfbOcr = "true";
        script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR engine failed to start."));
        script.onerror = () => reject(new Error("Could not load OCR. Check your internet connection and retry."));
        document.head.appendChild(script);
      });
      const result = await Tesseract.recognize(file, "eng", {
        logger: (event) => {
          if (event.status === "recognizing text") {
            const percent = Math.round((event.progress || 0) * 100);
            setProgress(percent);
            setMessage("Reading text… " + percent + "%");
          } else if (event.status) {
            setMessage(event.status === "loading tesseract core" ? "Loading OCR engine…" : "Preparing text recognition…");
          }
        },
      });
      const text = result.data?.text?.trim() || "";
      setExtractedText(text);
      setProgress(100);
      setMessage(text ? "Text extraction complete. Review and edit the result below." : "No readable text was detected. Try a clearer, well-lit image.");
    } catch (error) {
      setMessage(error.message || "Text extraction failed. Please try again.");
    } finally {
      setWorking(false);
    }
  };

  const capturePage = () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video?.videoHeight) {
      setMessage("Wait until the camera preview is ready, then capture.");
      return;
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 2200 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      setMessage("The camera image could not be captured.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) recognizeImage(new File([blob], "PWFB-camera-scan.jpg", { type: "image/jpeg" }));
      else setMessage("The camera image could not be saved. Try again.");
    }, "image/jpeg", 0.94);
  };

  const copyText = async () => {
    if (!extractedText) return;
    try {
      await navigator.clipboard.writeText(extractedText);
      setMessage("Extracted text copied to clipboard.");
    } catch {
      setMessage("Clipboard access is unavailable. Select the text and copy it manually.");
    }
  };

  const downloadText = () => {
    if (!extractedText) return;
    const blob = new Blob([extractedText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = (fileName.replace(/\.[^.]+$/, "") || "PWFB-scan") + ".txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="scan-pdf-page scan-text-page">
      <div className="scan-pdf-heading">
        <div>
          <p className="auth-eyebrow">DOCUMENT TOOLS</p>
          <h2>Scan to Text</h2>
          <p>Capture a document or upload an image to extract editable text directly in PWFB Financial Potal.</p>
        </div>
      </div>
      <div className="scan-camera-panel">
        <video ref={videoRef} className={cameraOn ? "scan-video" : "scan-video scan-video-hidden"}
          playsInline muted aria-label="Live document camera preview" />
        {!cameraOn && <div className="scan-camera-placeholder">
          <strong>Scan a document into text</strong>
          <span>Use your camera or select an image from your device. No WPS or external app is required.</span>
        </div>}
        <div className="scan-camera-actions">
          {!cameraOn ? <button type="button" className="scan-primary-button" onClick={startCamera}>Open camera</button> : <>
            <button type="button" className="scan-primary-button" onClick={capturePage} disabled={working}>Capture &amp; extract text</button>
            <button type="button" className="scan-secondary-button" onClick={stopCamera}>Stop camera</button>
          </>}
          <label className="scan-secondary-button">
            Upload image
            <input type="file" accept="image/*" capture="environment" disabled={working}
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) recognizeImage(file); }} />
          </label>
        </div>
      </div>
      {previewUrl && <section className="scan-pages-panel">
        <div className="scan-pages-heading"><div><h3>Original image</h3><p>{fileName}</p></div></div>
        <img className="scan-text-preview" src={previewUrl} alt="Document being scanned" />
      </section>}
      {working && <div className="scan-status" role="status">Extracting text… {progress}%</div>}
      <section className="scan-pages-panel scan-text-result">
        <div className="scan-pages-heading"><div><h3>Extracted text</h3><p>Review and correct OCR results before copying or saving.</p></div></div>
        <textarea value={extractedText} onChange={(event) => setExtractedText(event.target.value)}
          placeholder="Your extracted document text will appear here…" rows={14} />
        <div className="scan-camera-actions">
          <button type="button" className="scan-primary-button" onClick={copyText} disabled={!extractedText}>Copy text</button>
          <button type="button" className="scan-secondary-button" onClick={downloadText} disabled={!extractedText}>Download .txt</button>
          <button type="button" className="scan-secondary-button" onClick={() => { setExtractedText(""); setMessage("Extracted text cleared."); }} disabled={!extractedText}>Clear text</button>
        </div>
      </section>
      {message && <p className="scan-status" role="status">{message}</p>}
      <p className="scan-privacy-note">OCR runs in your browser. The image and extracted text are not uploaded to the PWFB financial database by this page. OCR may misread figures, so verify important amounts against the original document.</p>
    </div>
  );
}

export function DisbursementAnalysisPage() {
  return (
    <div className="analysis-page">
      <div className="analysis-page-heading">
        <div>
          <p className="auth-eyebrow">PWFB · FINANCE RECORDS</p>
          <h2>Daily Disbursement Analyses Sheet</h2>
          <p>One combined report containing the disbursement and receipts/reconciliation sections.</p>
        </div>
        <span>06 November 2026</span>
      </div>
      <article className="analysis-card analysis-combined-card">
        <div className="analysis-card-title">
          <span>COMBINED DAILY REPORT</span>
          <h3>Daily Disbursement Analysis &amp; Reconciliation</h3>
          <p>PERFECT WISDOM FOR BETTER LTD · 06/11/2026</p>
        </div>
        <div className="analysis-figures">
          <div><span>Opening Balance</span><strong>₦12,689,796.53</strong></div>
          <div><span>Received from POS 75</span><strong>₦5,000,000.00</strong></div>
        </div>
        <InlineCameraScan area="Combined Daily Disbursement Analysis and Reconciliation" />
        <section className="analysis-report-section">
          <h4>Daily Disbursement Analysis</h4>
          <div className="analysis-table-wrap">
            <table className="analysis-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Batch</th><th rowSpan={2}>Region</th>
                  <th colSpan={2}>Disbursement</th>
                  <th colSpan={2}>Reversed / Declined</th>
                  <th colSpan={2}>Total Balance</th><th rowSpan={2}>Remark</th>
                </tr>
                <tr>{["No", "Amount", "No", "Amount", "No", "Amount"].map((value, index) =>
                  <th key={index}>{value}</th>
                )}</tr>
              </thead>
              <tbody>
                {[0, 1, 2].map((row) =>
                  <tr key={row}>{Array.from({ length: 9 }).map((_, cell) =>
                    <td key={cell}>&nbsp;</td>
                  )}</tr>
                )}
                <tr><td colSpan={2}>TOTAL C/F</td><td colSpan={7}>₦17,689,796.53</td></tr>
                <tr><td colSpan={2}>Current Balance</td><td colSpan={7}>₦17,689,446.53</td></tr>
              </tbody>
            </table>
          </div>
        </section>
        <section className="analysis-report-section">
          <h4>Receipts &amp; Reconciliation</h4>
          <div className="analysis-table-wrap">
            <table className="analysis-table">
              <thead><tr>{["Received", "Excess Rc", "Shortage Rc", "Disbursement", "Balance", "Remark"].map((value) =>
                <th key={value}>{value}</th>
              )}</tr></thead>
              <tbody>
                <tr>
                  <td>₦115,282.00</td><td>&nbsp;</td><td>&nbsp;</td><td>—</td>
                  <td>₦115,282.00</td><td rowSpan={3}>₦17,362,600 to be done with POS.</td>
                </tr>
                <tr><td>₦58,344.00</td><td>&nbsp;</td><td>&nbsp;</td><td>—</td><td>₦58,344.00</td></tr>
                <tr><td>₦17,362,600.00</td><td>&nbsp;</td><td>&nbsp;</td><td>—</td><td>₦17,362,600.00</td></tr>
                {[0, 1].map((row) =>
                  <tr key={row}>{Array.from({ length: 6 }).map((_, cell) =>
                    <td key={cell}>&nbsp;</td>
                  )}</tr>
                )}
                <tr className="analysis-total-row"><td>TOTAL</td>{[0, 1, 2, 3, 4].map((cell) =>
                  <td key={cell}>&nbsp;</td>
                )}</tr>
              </tbody>
            </table>
          </div>
        </section>
      </article>
      <p className="analysis-data-note">
        Both original report sections are kept together in one report card. Figures and blank cells are preserved as supplied;
        no missing values have been estimated. These displayed source figures are not database-reconciled transactions.
      </p>
    </div>
  );
}

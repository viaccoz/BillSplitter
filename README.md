# BillSplitter

Client-side web application for scanning restaurant receipts, detecting items, and easily splitting the receipt.

## Features

- Client-side OCR parsing: Powered by [Tesseract.js](https://tesseract.projectnaptha.com/), receipts are processed entirely within the browser. No images or financial data are ever uploaded to a server.
- Smart total detection: Intelligently detects the printed receipt total using key-phrase matching (e.g. "Total", "Montant", "Summe") to isolate items and automatically filter out subsequent receipt noise (such as taxes, tip, payments, or change).
- Visual mapping: The OCR engine maps extracted text bounding boxes back to the original image canvas, allowing users to visually cross-reference items.
- Dynamic assignment: Easily split individual items between multiple people, or split all items equally with a single click. 
- Auto-calculated tips: Instantly add quick-percentage tips or custom amounts. Tips are automatically distributed proportionally based on each person's share of the base subtotal.
- Cross-device sharing: The entire application state is serialized into a lightweight Base64 string within the URL hash. You can share the active splitting session with friends just by copying the URL—no database required.
- Mobile-first responsive design: Fluid, modern UI featuring micro-animations, glassmorphism, and a sleek dark mode.

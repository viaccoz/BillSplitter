# BillSplitter 🧾

A purely client-side, zero-backend web application for scanning restaurant receipts, detecting items, and easily splitting the bill with friends. 

## Features ✨

- **Client-Side OCR Parsing**: Powered by [Tesseract.js](https://tesseract.projectnaptha.com/), receipts are processed entirely within the browser. No images or financial data are ever uploaded to a server.
- **Smart Total Detection**: Uses a dynamic programming subset-sum algorithm to intelligently match the parsed item prices against the total on the receipt, filtering out noise, taxes, and change.
- **Visual Mapping**: The OCR engine maps extracted text bounding boxes back to the original image canvas, allowing users to visually cross-reference items.
- **Dynamic Assignment**: Easily split individual items between multiple people, or split all items equally with a single click. 
- **Auto-Calculated Tips**: Instantly add quick-percentage tips or custom amounts. Tips are automatically distributed proportionally based on each person's share of the base subtotal.
- **Cross-Device Sharing**: The entire application state is serialized into a lightweight Base64 string within the URL hash. You can share the active splitting session with friends just by copying the URL—no database required.
- **Mobile-First Responsive Design**: Fluid, modern UI featuring micro-animations, glassmorphism, and a sleek dark mode.

## Technologies Used 🛠️

- **HTML5 & Vanilla JavaScript**: Minimal dependencies, maximizing speed and maintainability.
- **CSS3 / CSS Variables**: A robust, purely custom design system.
- **Tesseract.js WebAssembly**: Asynchronous background workers for high-performance Optical Character Recognition.

## Getting Started 🚀

Since BillSplitter is purely client-side, it is incredibly simple to run.

### Running Locally

1. Clone this repository to your local machine.
2. Open your terminal and navigate to the project directory:
   ```bash
   cd BillSplitter
   ```
3. Start a local development server (this is necessary to avoid CORS issues when fetching the WebAssembly web workers for Tesseract.js):
   ```bash
   # If you have Python 3 installed:
   python -m http.server 8000
   
   # Or using Node.js:
   npx serve .
   ```
4. Open your browser and navigate to `http://localhost:8000`.

### Security Note

The application runs an extremely restrictive Content Security Policy (CSP) designed to block unauthorized script execution and protect user data. Scripts and worker configurations are tightly scoped to whitelisted CDNs.

## How to Use 📖

1. **Upload**: Take a picture of your receipt or upload an existing image.
2. **Review**: Check the extracted OCR items. Adjust prices, add missing items, and specify the printed ticket total to verify against the item subtotal.
3. **People**: Add the names of everyone at the table.
4. **Assign**: Tap people's names to assign items to them. Items assigned to multiple people are split equally.
5. **Summary**: Review the final, customized totals (including proportionate tips) for each person!

export default function Home() {
  return (
    <main className="mx-0 flex max-w-160 flex-col gap-5 px-6 py-24 text-left">
      <div>
        <h1 className="text-[2.5rem] font-bold text-ink">ScanLint</h1>
        <div className="mt-3 h-0.75 w-16 bg-signal" />
      </div>
      <p className="text-xl text-ink">
        Find identifying information hidden in medical image files — without
        ever uploading them.
      </p>
      <p className="text-shade">Stage 1 in development.</p>
      <p className="text-shade">
        When it launches, every file you load will be read and analysed
        entirely in your browser. Nothing is uploaded.
      </p>
      <a
        href="https://raihanvaheed.dev"
        className="text-signal underline"
      >
        By Raihan Abdul Vaheed
      </a>
    </main>
  );
}

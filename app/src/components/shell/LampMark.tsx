/** 品牌标记：几何台灯（DESIGN.md「深夜里的一盏台灯」），不用法槌天平。 */
export function LampMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 10.5L12 3l5 7.5z" />
      <path d="M12 10.5V19" strokeLinecap="round" />
      <path d="M8 20.5h8" strokeLinecap="round" />
    </svg>
  );
}

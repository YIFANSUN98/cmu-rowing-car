export function ClubBrand({ closing = false }: { closing?: boolean }) {
  return (
    <a
      className={`brand${closing ? ' brand--closing' : ''}`}
      href="#top"
      aria-label={closing ? 'CMU Rowing · back to top' : 'CMU Rowing home'}
    >
      <span className="brand-mark">
        <img
          className="brand-logo"
          src={`${import.meta.env.BASE_URL}branding/cmu-rowing-logo.png`}
          alt=""
          width="112"
          height="112"
        />
      </span>
      <span className="brand-wordmark">
        CMU <b>ROWING</b>
        <small>THE WAY TO THE WATER</small>
      </span>
    </a>
  );
}

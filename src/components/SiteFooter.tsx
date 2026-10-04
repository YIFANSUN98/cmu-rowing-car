import { ClubBrand } from './ClubBrand';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <ClubBrand closing />
      <div className="site-credits">
        <p>
          Website owned by <strong>CMU Rowing</strong>
        </p>
        <p>
          Developed by <strong>Yifan Sun</strong> ·{' '}
          <a href="mailto:yifansu2@andrew.cmu.edu">yifansu2@andrew.cmu.edu</a>
        </p>
      </div>
    </footer>
  );
}
